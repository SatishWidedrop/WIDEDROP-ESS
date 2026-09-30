# The documents

Two kinds live in here, and reading one as the other wastes an afternoon.

## Written after the build — correct about the system as it is

|                  |                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`PLAN.md`**    | What was asked for, the milestones it was broken into, what each delivered, and what is not built. Start here.                                                                |
| **`RUNBOOK.md`** | Operating it: what to check first, the incident playbooks, deploys, rollbacks, restores, secret rotation. Written for whoever is on call, who may not have written any of it. |
| **`RBAC.md`**    | Who can do what, over whom. **Generated** from `packages/shared/src/rbac/roles.ts` by `npm run docs:rbac`; CI fails if it has drifted.                                        |

## Written before the build — the design specification

`API.md`, `SECURITY.md`, `DATA-MODEL.md`, `WORKFLOWS.md`, `FRONTEND.md`,
`ARCHITECTURE.md`, `DEPLOYMENT.md`.

These were written first and are kept because the reasoning in them is worth
having: each records why a decision went the way it did, which the code can show
but not explain. They are not a description of what shipped. Where they and the
code disagree, **the code is correct**, and each document carries a banner
naming what to read instead for its own subject.

The one divergence worth knowing before you read any of them: these documents
fold the scope into the permission name — `payslip:read:any`,
`approval:task:read:team`. What was built separates the two, so a permission
names an action and each role holds it _at a scope_: `payslip:read-any` held at
`ORG`. The permission type is a literal union, so a name from the older scheme
does not compile — but it will still be sitting in the prose.

## Where the truth actually is

When a document and the code disagree, these are the files that settle it.

| Question                                 | File                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| What shape is the data?                  | `apps/api/prisma/schema.prisma`, and the SQL in `prisma/migrations/` for what Prisma cannot express                                     |
| Who can do what?                         | `packages/shared/src/rbac/roles.ts`                                                                                                     |
| What does this endpoint return?          | the route module in `apps/api/src/routes/v1/`, and its test beside it                                                                   |
| What states can this move between?       | `packages/shared/src/domain/`                                                                                                           |
| What does this screen do?                | `apps/web/src/features/`                                                                                                                |
| What must be set to run it?              | `apps/api/src/config/env.ts`, checked against `.env.example` and `infra/render/render.yaml` by `apps/api/src/config/deployment.test.ts` |
| What does the deployed system look like? | `infra/netlify/`, `infra/render/`, `apps/api/Dockerfile`, `.github/workflows/`                                                          |
| What is the UI meant to look like?       | `design/prototype/` and `design/DESIGN-SYSTEM.md`                                                                                       |
