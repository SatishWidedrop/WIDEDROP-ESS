import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import {
  ACCEPTED_UPLOAD_TYPES,
  FILE_LIMITS,
  safeDisplayFilename,
  type AcceptedUploadMime,
} from '@widedrop/shared';
import { fileTypeFromBuffer } from 'file-type';
import type { Env } from '../../config/env.js';
import { AppError, ERROR_CODES, badRequest } from '../../lib/errors.js';
import { buildStorageKey } from '../../lib/storage/types.js';
import type { Tx } from '../../lib/prisma.js';
import type { FilePurpose } from '../../generated/prisma/index.js';
import { storage } from '../storage.js';
import { recordAudit } from '../audit.js';

/**
 * Accepting a file.
 *
 * An upload is the one place where bytes somebody else chose reach this
 * system, so every decision here is made on our side of the boundary:
 *
 *  - the stored key is generated, never derived from the client's filename;
 *  - the content type recorded is the one sniffed from the bytes, never the
 *    one the request declared;
 *  - a type not on the accept list is refused, and so is one whose magic bytes
 *    disagree with the extension its own name claims;
 *  - the row and the object are written in an order that can only leak an
 *    unreferenced object, never a row pointing at bytes that are not there.
 *
 * The size bound is enforced twice: by the multipart plugin as the stream
 * arrives, and again here, because the plugin's truncation flag is the only
 * thing that distinguishes a file that ended from one that was cut off.
 */

/** What `put` needs before it will touch storage. */
export interface AcceptUploadInput {
  organizationId: string;
  purpose: FilePurpose;
  /** The employee the file is about — used for scope checks on download. */
  subjectEmployeeId?: string | undefined;
  uploadedByUserId?: string | undefined;
  /** How long the file is kept, when a retention rule applies to this purpose. */
  deleteAfter?: Date | undefined;
}

export interface AcceptedUpload {
  fileObjectId: string;
  storageKey: string;
  displayFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Read a multipart part into memory, bounded.
 *
 * Buffered rather than streamed straight to storage, because the type cannot
 * be known until the first bytes have been seen and the checksum cannot be
 * known until the last — and an object written before either is known is an
 * object that has to be deleted again when the answer turns out to be no.
 * Ten megabytes is the plugin's own ceiling.
 */
async function readBounded(part: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of part.file) {
    total += chunk.length;
    if (total > FILE_LIMITS.maxBytes) {
      // Stop reading rather than accumulating: the point of a limit is not to
      // find out afterwards how far over it somebody went.
      part.file.destroy();
      throw tooLarge();
    }
    chunks.push(chunk as Buffer);
  }

  // The plugin sets this when it cut the stream at the limit. Without the
  // check, a truncated PDF would be stored as a whole one.
  if (part.file.truncated) throw tooLarge();
  if (total === 0) throw badRequest('The file is empty.');

  return Buffer.concat(chunks);
}

const tooLarge = () =>
  new AppError(
    413,
    ERROR_CODES.VALIDATION_FAILED,
    `That file is larger than ${Math.round(FILE_LIMITS.maxBytes / (1024 * 1024))} MB.`,
  );

/**
 * What the bytes actually are.
 *
 * `file-type` reads magic bytes; it does not trust, or even look at, the
 * declared type or the extension. Both are then required to agree with it,
 * which is what stops an HTML file arriving as `invoice.pdf` and being served
 * back later as one.
 */
async function sniff(
  body: Buffer,
  declared: string,
  filename: string,
): Promise<AcceptedUploadMime> {
  const detected = await fileTypeFromBuffer(body);

  if (!detected) {
    throw badRequest('That file type could not be identified. Upload a PDF, JPEG, PNG or WebP.');
  }

  const accepted = Object.keys(ACCEPTED_UPLOAD_TYPES) as AcceptedUploadMime[];
  if (!accepted.includes(detected.mime as AcceptedUploadMime)) {
    throw badRequest(
      `Files of type ${detected.mime} are not accepted. Upload a PDF, JPEG, PNG or WebP.`,
    );
  }

  const mime = detected.mime as AcceptedUploadMime;

  // The declared type is checked against the sniffed one rather than used.
  // A mismatch is not fatal on its own — browsers get this wrong — but a
  // *deliberate* mismatch is the attack, so it is refused either way and the
  // message says which one won.
  const declaredBase = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (declaredBase && declaredBase !== mime) {
    throw badRequest(
      `That file is a ${mime}, not a ${declaredBase}. Upload it under its real type.`,
    );
  }

  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const allowedExtensions: readonly string[] = ACCEPTED_UPLOAD_TYPES[mime];
  if (extension && !allowedExtensions.includes(extension)) {
    throw badRequest(`That file is a ${mime}; rename it to end in .${allowedExtensions[0]}.`);
  }

  return mime;
}

/**
 * Store a file and record it.
 *
 * The object is written before the row so that a failure between them leaves
 * an object nothing points at — reclaimable by a lifecycle rule, and harmless
 * — rather than a row pointing at bytes that were never written, which every
 * later download would fail on.
 *
 * The caller supplies the transaction, so the FileObject row and whatever
 * references it (an expense attachment, a policy version) commit together or
 * not at all.
 */
export async function acceptUpload(
  tx: Tx,
  env: Env,
  part: MultipartFile,
  input: AcceptUploadInput,
): Promise<AcceptedUpload> {
  const displayFilename = safeDisplayFilename(part.filename);
  const body = await readBounded(part);
  const contentType = await sniff(body, part.mimetype, displayFilename);

  const objectId = randomUUID();
  const storageKey = buildStorageKey({
    purpose: input.purpose,
    scopeId: input.subjectEmployeeId ?? input.organizationId,
    objectId,
    extension: ACCEPTED_UPLOAD_TYPES[contentType][0],
    date: new Date(),
  });

  const stored = await storage(env).put({
    key: storageKey,
    body,
    contentType,
    downloadFilename: displayFilename,
    metadata: {
      organization: input.organizationId,
      purpose: input.purpose,
      ...(input.subjectEmployeeId ? { subject: input.subjectEmployeeId } : {}),
    },
  });

  const file = await tx.fileObject.create({
    data: {
      organizationId: input.organizationId,
      purpose: input.purpose,
      storageKey: stored.key,
      displayFilename,
      contentType,
      sizeBytes: stored.size,
      sha256: stored.sha256,
      // No scanner is wired up, and saying PENDING would claim one is coming.
      // SKIPPED is the honest value, and it is the one a scanner would later
      // look for to find the backlog it never processed.
      scanStatus: 'SKIPPED',
      ...(input.uploadedByUserId ? { uploadedByUserId: input.uploadedByUserId } : {}),
      ...(input.subjectEmployeeId ? { subjectEmployeeId: input.subjectEmployeeId } : {}),
      ...(input.deleteAfter ? { deleteAfter: input.deleteAfter } : {}),
    },
    select: { id: true },
  });

  await recordAudit(
    tx,
    {
      organizationId: input.organizationId,
      // There is no UPLOAD action: a file arriving is a FileObject row being
      // created, and the trail reads better for saying so than for growing an
      // action that means the same thing.
      action: 'CREATE',
      entityType: 'FileObject',
      entityId: file.id,
      summary: `Uploaded ${displayFilename} (${contentType}, ${stored.size} bytes)`,
      // The bytes are not in the trail; what they were and where they went is.
      after: { purpose: input.purpose, sha256: stored.sha256, storageKey: stored.key },
    },
    env.AUDIT_HMAC_KEY,
  );

  return {
    fileObjectId: file.id,
    storageKey: stored.key,
    displayFilename,
    contentType,
    sizeBytes: stored.size,
    sha256: stored.sha256,
  };
}

/**
 * The single file of a request, or a clear refusal.
 *
 * `request.file()` resolves to undefined when the body carried no file part,
 * which reads as a server error at the call site unless it is turned into one
 * here.
 */
export async function requireUploadedFile(file: MultipartFile | undefined): Promise<MultipartFile> {
  if (!file) throw badRequest('Attach a file.');
  return file;
}
