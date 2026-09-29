const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const I = {
  home:'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  payslips:'M5 3h14v18l-2.5-1.8L14 21l-2-1.6L10 21l-2.5-1.8L5 21zM9 8h6M9 12h6M9 16h3',
  tax:'M6 3h9l4 4v14H6zM15 3v4h4M9.5 16.5l5-5M10 11.5h.01M14.5 16h.01',
  profile:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  leave:'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  attendance:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  benefits:'M12 21s-7-4.5-7-11a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 6.5-7 11-7 11z',
  expenses:'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V5a2 2 0 0 1 2-2h11v4M16 14h.01',
  documents:'M7 3h7l5 5v13H7zM14 3v5h5M10 13h5M10 17h5',
  policies:'M5 4h13a1 1 0 0 1 1 1v14H7a2 2 0 0 0-2 2zM5 4v17M9 8h6',
  directory:'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4a3.5 3.5 0 0 1 0 7M22 20a7 7 0 0 0-5-6.7',
  announcements:'M3 10v4l11 4V6zM14 9a3 3 0 0 1 0 6M7 14v5h3v-4',
  help:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  approvals:'M9 12l2 2 4-4M4 4h16v16H4z',
  menu:'M4 7h16M4 12h16M4 17h16',
};
const NAV = [['home','Home','Overview'],['payslips','Payslips','Pay & tax'],['tax','Tax slips','Pay & tax'],['profile','My profile','My workplace'],['leave','Leave','My workplace'],['benefits','Benefits','My workplace'],['expenses','Expenses','My workplace'],['documents','Documents','My workplace'],['policies','Policies','Company'],['directory','Directory','Company'],['announcements','Announcements','Company'],['help','Help desk','Support'],['approvals','Approvals','Manager']].map(([id,label,group])=>({id,label,group,icon:I[id]}));
const TITLES = Object.fromEntries(NAV.map(n=>[n.id,n.label]));
const TONE = {green:['#14332A','#5EDBA0'],amber:['#3A2D12','#F5C46B'],red:['#3B1E1E','#F58C86'],blue:['#1B365D','#9CC2FF'],gray:['#222D40','#A9B4C7']};
const chip = (label,tone) => ({label,bg:TONE[tone][0],fg:TONE[tone][1]});

const mkPay = (id,month,paid,days,ref,basic,hra,spl,lta,tds,extra) => {
  const pf=Math.round(basic*0.12);
  const earn=[['Basic salary',basic],['House rent allowance',hra],['Special allowance',spl],['Leave travel allowance',lta],['Conveyance allowance',1600]];
  if(extra) earn.push(extra);
  const ded=[['Provident fund (employee)',pf],['Income tax (TDS)',tds],['Professional tax',200],['Group insurance premium',480]];
  const gross=earn.reduce((s,e)=>s+e[1],0), dt=ded.reduce((s,e)=>s+e[1],0);
  return {id,month,paid,days,ref,gross,dedTotal:dt,net:gross-dt,pf,tds,earn:earn.map(([k,v])=>({k,v:inr(v)})),ded:ded.map(([k,v])=>({k,v:inr(v)})),netFmt:inr(gross-dt),grossFmt:inr(gross),dedFmt:inr(dt),pfFmt:inr(pf),tdsFmt:inr(tds)};
};
const PAYSLIPS = [
  mkPay('aug26','August 2026','31 Aug 2026','31 / 31','WDT-PS-2608-1847',86000,43000,45400,7200,22860),
  mkPay('jul26','July 2026','31 Jul 2026','31 / 31','WDT-PS-2607-1847',86000,43000,45400,7200,22860),
  mkPay('jun26','June 2026','30 Jun 2026','30 / 30','WDT-PS-2606-1847',86000,43000,45400,7200,22860),
  mkPay('may26','May 2026','29 May 2026','31 / 31','WDT-PS-2605-1847',86000,43000,45400,7200,24790,['Performance incentive',6420]),
  mkPay('apr26','April 2026','30 Apr 2026','30 / 30','WDT-PS-2604-1847',86000,43000,45400,7200,22860),
  mkPay('mar26','March 2026','31 Mar 2026','31 / 31','WDT-PS-2603-1847',82000,41000,42400,7800,20990),
];
const FY = PAYSLIPS.slice(0,5);
const YTD = [
  {k:'Gross earned',v:inr(FY.reduce((s,p)=>s+p.gross,0)),sub:'Apr – Aug 2026'},
  {k:'Net credited',v:inr(FY.reduce((s,p)=>s+p.net,0)),sub:'5 payslips'},
  {k:'TDS deducted',v:inr(FY.reduce((s,p)=>s+p.tds,0)),sub:'Reflected in Form 26AS'},
  {k:'PF contributed',v:inr(FY.reduce((s,p)=>s+p.pf*2,0)),sub:'Employee + employer'},
];
const TAXQ = [
  {q:'Q1 · Apr – Jun 2026',amt:'₹70,510',status:chip('Filed','green')},
  {q:'Q2 · Jul – Sep 2026',amt:'₹45,720',status:chip('In progress','amber')},
  {q:'Q3 · Oct – Dec 2026',amt:'—',status:chip('Upcoming','gray')},
  {q:'Q4 · Jan – Mar 2027',amt:'—',status:chip('Upcoming','gray')},
];
const FORM16 = [
  {fy:'FY 2025–26',issued:'Issued 12 Jun 2026',file:'Form16_FY2025-26.pdf'},
  {fy:'FY 2024–25',issued:'Issued 10 Jun 2025',file:'Form16_FY2024-25.pdf'},
  {fy:'FY 2023–24',issued:'Issued 14 Jun 2024',file:'Form16_FY2023-24.pdf'},
];
const PROFILE = {
  personal:[['Full name','Priya Raghavan'],['Date of birth','14 Feb 1994'],['Gender','Female'],['Blood group','O+'],['Marital status','Married'],['Nationality','Indian'],['Personal email','priya.r94@gmail.com'],['Mobile','+91 98450 12234'],['Current address','42, 3rd Cross, Koramangala 5th Block, Bengaluru 560095'],['Permanent address','18 Lake View Road, Adyar, Chennai 600020']],
  employment:[['Employee ID','WDT-01847'],['Designation','Senior Software Engineer'],['Department','Platform Engineering'],['Business unit','Product & Engineering'],['Reporting manager','Arjun Malhotra'],['HR business partner','Ananya Bose'],['Work location','Bengaluru · Ecospace Campus'],['Employment type','Full-time · Permanent'],['Date of joining','11 Jul 2022'],['Tenure','4 years 2 months'],['Work email','priya.raghavan@widedrop.com'],['Cost centre','CC-4120 · Platform'],['Notice period','60 days']],
  bank:[['Bank','HDFC Bank'],['Account number','•••• •••• 4412'],['IFSC','HDFC0000523'],['PAN','AXYPR••••K'],['Aadhaar','•••• •••• 8821'],['UAN','1012 3456 7890'],['PF account','KA/BNG/0048221/000/0001847'],['ESI','Not applicable'],['Tax regime','New regime · FY 2026–27']],
  emergency:[['Primary contact','Karthik Raghavan'],['Relationship','Spouse'],['Phone','+91 98860 44521'],['Secondary contact','Lakshmi Raghavan'],['Relationship','Mother'],['Phone','+91 94440 12876']],
};
const PNOTES = {
  personal:'Name and date of birth changes need a government ID. Address and contact details update instantly after HR review.',
  employment:'Employment details are maintained by People Ops. Raise a ticket if anything here is out of date.',
  bank:'Masked for your security. Bank and statutory changes need a cancelled cheque or ID proof and are verified by Payroll within 2 working days.',
  emergency:'Emergency contacts are visible only to People Ops and your manager.',
};
const PTABS = [['personal','Personal'],['employment','Employment'],['bank','Bank & statutory'],['emergency','Emergency contacts']];
const POLICIES = [
  {id:'coc',name:'Code of Conduct',ver:'v3.1',updated:'Jan 2026',owner:'People Ops',ack:'12 Jan 2026',summary:'The standards of behaviour every Widedrop employee, contractor and director is expected to uphold — with colleagues, customers, partners and the public.',applies:'All employees & contractors',effective:'1 Jan 2026',review:'Jan 2027',contact:'ethics@widedrop.com',points:['Act with integrity in every interaction with colleagues, customers and partners.','Disclose conflicts of interest to your manager or People Ops within 7 days.','Report violations through the Speak Up channel; retaliation of any kind is prohibited.']},
  {id:'isp',name:'Information Security Policy',ver:'v4.2',updated:'Sep 2026',owner:'IT & Security',ack:null,due:'15 Oct 2026',summary:'How we protect company and customer information across devices, accounts, SaaS tools and code — and what to do when something goes wrong.',applies:'All employees & contractors',effective:'1 Oct 2026',review:'Sep 2027',contact:'security@widedrop.com',points:['Multi-factor authentication is mandatory on all company SaaS tools from 1 Oct 2026.','Customer data may only be accessed through approved, logged systems — never exported to personal devices.','Report suspected phishing or a lost device to security@widedrop.com within 1 hour.']},
  {id:'leave',name:'Leave Policy',ver:'v2.4',updated:'Apr 2026',owner:'People Ops',ack:'3 Apr 2026',summary:'Leave types, accrual, carry-forward and the approval process for full-time employees in India.',applies:'Full-time employees · India',effective:'1 Apr 2026',review:'Apr 2027',contact:'people@widedrop.com',points:['Earned leave accrues at 1.5 days per month; up to 30 days carry forward.','Apply at least 3 working days ahead for planned leave; sick leave beyond 2 days needs a medical certificate.','Unused casual leave lapses on 31 December.']},
  {id:'wfh',name:'Work From Home & Hybrid Policy',ver:'v2.0',updated:'Apr 2026',owner:'People Ops',ack:'3 Apr 2026',summary:'Expectations for hybrid working: office anchor days, remote-work approvals and the equipment and reimbursements available to you.',applies:'All employees',effective:'1 Apr 2026',review:'Apr 2027',contact:'people@widedrop.com',points:['Three days a week in your base office; anchor days are set by your team.','Remote work outside your base city needs manager approval for stays over 2 weeks.','A ₹1,500 monthly internet reimbursement is available through Expenses.']},
  {id:'tne',name:'Travel & Expense Policy',ver:'v3.0',updated:'Jul 2026',owner:'Finance',ack:null,due:'31 Oct 2026',summary:'How to book business travel, what can be claimed, spending limits and how reimbursements are paid.',applies:'All employees',effective:'1 Aug 2026',review:'Jul 2027',contact:'finance@widedrop.com',points:['Book travel through the Widedrop travel desk; self-booked travel is reimbursed at capped rates.','Submit claims within 30 days of spend with itemised bills.','Domestic per-diem is ₹2,500 per day; international per-diem follows the country table.']},
  {id:'posh',name:'Prevention of Sexual Harassment (POSH)',ver:'v1.6',updated:'Mar 2026',owner:'Internal Committee',ack:'20 Mar 2026',summary:'Our commitment to a safe, respectful workplace under the POSH Act 2013, including how complaints are raised, investigated and resolved.',applies:'All employees, contractors & visitors',effective:'1 Mar 2026',review:'Mar 2027',contact:'ic@widedrop.com',points:['Zero tolerance for sexual harassment at the workplace, including remote and off-site settings.','Complaints can be raised with the Internal Committee within 3 months of an incident.','Every employee completes POSH awareness training annually.']},
  {id:'abc',name:'Anti-Bribery & Gifts Policy',ver:'v1.2',updated:'Nov 2025',owner:'Legal',ack:'18 Nov 2025',summary:'Rules on gifts, hospitality and payments involving vendors, customers and public officials, in line with the Prevention of Corruption Act.',applies:'All employees & directors',effective:'1 Dec 2025',review:'Nov 2026',contact:'legal@widedrop.com',points:['Gifts above ₹5,000 from vendors or customers must be declared and may be declined.','Facilitation payments of any kind are prohibited.','All third-party engagements go through compliance due diligence.']},
  {id:'dpp',name:'Data Privacy Policy',ver:'v2.1',updated:'Feb 2026',owner:'Legal',ack:'9 Feb 2026',summary:'How Widedrop collects, uses, stores and deletes personal data of employees and customers under the DPDP Act 2023.',applies:'All employees & contractors',effective:'1 Mar 2026',review:'Feb 2027',contact:'privacy@widedrop.com',points:['Personal data is processed under the DPDP Act 2023 and only for stated purposes.','You can request access to or correction of your personal data through the Help desk.','Retention follows the schedule published by Legal.']},
];
const BAL = [['Earned leave',14.5,18],['Casual leave',6,12],['Sick leave',8,10],['Comp-off',1,1],['Restricted holiday',1,2]].map(([k,left,total])=>({k,left,total,pct:Math.round(left/total*100)+'%'}));
const LEAVES0 = [
  {id:1,type:'Earned leave',range:'20 – 24 Oct 2026',days:'5 days',note:'Dussehra week with family',status:chip('Approved','green'),pending:false},
  {id:2,type:'Sick leave',range:'15 Sep 2026',days:'1 day',note:'Fever',status:chip('Approved','green'),pending:false},
  {id:3,type:'Casual leave',range:'14 Aug 2026',days:'1 day',note:'Personal errand',status:chip('Approved','green'),pending:false},
  {id:4,type:'Sick leave',range:'2 – 3 Jul 2026',days:'2 days',note:'Approved by Arjun Malhotra',status:chip('Approved','green'),pending:false},
];
const HOL = [{name:'Gandhi Jayanti',day:'2',mon:'Oct',dow:'Fri'},{name:'Dussehra · Vijaya Dashami',day:'20',mon:'Oct',dow:'Tue'},{name:'Diwali (observed)',day:'9',mon:'Nov',dow:'Mon'},{name:'Christmas',day:'25',mon:'Dec',dow:'Fri'}];
const BENEFITS = [
  {cat:'Health',name:'Group health insurance',value:'₹5,00,000',meta:'Family floater · ICICI Lombard · Policy WDT-GMC-2026 · Covers you, Karthik and Aarav',action:'Download e-card',toast:'Downloading GMC e-card · ICICI Lombard'},
  {cat:'Life',name:'Group term life',value:'3× annual CTC',meta:'HDFC Life · Nominee: Karthik Raghavan (100%)',action:'View policy',toast:'Opening HDFC Life policy document'},
  {cat:'Retirement',name:'Corporate NPS',value:'₹8,600 / mo',meta:'Employer contribution · 10% of basic · PRAN ••••4471',action:'Change contribution',toast:'Contribution changes apply from the next payroll'},
];
const DEPENDENTS = [{ini:'KR',name:'Karthik Raghavan',rel:'Spouse',age:'33 years',cover:'Health insurance · Nominee'},{ini:'AR',name:'Aarav Raghavan',rel:'Son',age:'4 years',cover:'Health insurance'}];
const EXP0 = [
  {id:'EXP-2291',title:'Client visit — cab rides',cat:'Travel',date:'24 Sep 2026',amt:1860,status:chip('Awaiting approval','amber'),k:'pending'},
  {id:'EXP-2274',title:'Team lunch — Q2 close',cat:'Meals & entertainment',date:'12 Sep 2026',amt:6400,status:chip('Approved','green'),k:'approved'},
  {id:'EXP-2210',title:'Mechanical keyboard',cat:'Equipment',date:'29 Aug 2026',amt:7499,status:chip('Reimbursed','blue'),k:'paid'},
  {id:'EXP-2188',title:'Internet bill — August',cat:'Remote work',date:'5 Aug 2026',amt:1199,status:chip('Reimbursed','blue'),k:'paid'},
  {id:'EXP-2153',title:'PyCon India ticket',cat:'Learning',date:'18 Jul 2026',amt:4500,status:chip('Rejected','red'),k:'rejected',note:'Use the L&D budget flow'},
  {id:'EXP-2102',title:'Internet bill — July',cat:'Remote work',date:'6 Jul 2026',amt:1199,status:chip('Reimbursed','blue'),k:'paid'},
  {id:'EXP-2067',title:'Home office chair',cat:'Equipment',date:'14 Jun 2026',amt:12500,status:chip('Reimbursed','blue'),k:'paid'},
];
const LET0 = [
  {id:1,type:'Salary certificate',req:'18 Sep 2026',note:'Addressed to HDFC Bank',status:chip('Issued','green'),issued:true},
  {id:2,type:'Address proof letter',req:'3 Jun 2026',note:'Addressed to Passport Seva Kendra',status:chip('Issued','green'),issued:true},
];
const DOCS = [
  {name:'Salary revision letter — FY 2026–27',date:'1 Apr 2026',cat:'Compensation'},
  {name:'Appraisal letter — FY 2025–26',date:'1 Apr 2026',cat:'Performance'},
  {name:'Promotion letter — Senior Software Engineer',date:'1 Apr 2025',cat:'Career'},
  {name:'Appointment letter',date:'11 Jul 2022',cat:'Onboarding'},
  {name:'Offer letter',date:'20 Jun 2022',cat:'Onboarding'},
];
const DEPT_COLOR = {'Platform Engineering':'#1B365D','Design':'#3B2A5C','People Ops':'#14332A','Finance':'#3A2D12','Quality':'#1F3A45','Leadership':'#3B1E1E'};
const PEOPLE = [
  {id:'am',name:'Arjun Malhotra',title:'Engineering Manager',dept:'Platform Engineering',loc:'Bengaluru',phone:'+91 98800 21134',rel:'manager',mgr:'Sameer Joshi'},
  {id:'pr',name:'Priya Raghavan',title:'Senior Software Engineer',dept:'Platform Engineering',loc:'Bengaluru',phone:'+91 98450 12234',rel:'you',mgr:'Arjun Malhotra'},
  {id:'nk',name:'Neha Kulkarni',title:'Software Engineer II',dept:'Platform Engineering',loc:'Bengaluru',phone:'+91 99010 44872',rel:'report',today:'Available',mgr:'Priya Raghavan'},
  {id:'rv',name:'Rahul Verma',title:'Software Engineer',dept:'Platform Engineering',loc:'Pune',phone:'+91 98220 51190',rel:'report',today:'Available',mgr:'Priya Raghavan'},
  {id:'fq',name:'Farhan Qureshi',title:'DevOps Engineer',dept:'Platform Engineering',loc:'Hyderabad',phone:'+91 90000 78321',rel:'report',today:'Available',mgr:'Priya Raghavan'},
  {id:'sn',name:'Sneha Nair',title:'Product Designer',dept:'Design',loc:'Bengaluru',phone:'+91 97400 33812',mgr:'Sameer Joshi'},
  {id:'vs',name:'Vikram Shetty',title:'Head of People',dept:'People Ops',loc:'Bengaluru',phone:'+91 98450 90021',mgr:'Sameer Joshi'},
  {id:'ab',name:'Ananya Bose',title:'HR Business Partner',dept:'People Ops',loc:'Bengaluru',phone:'+91 99860 12045',mgr:'Vikram Shetty'},
  {id:'kg',name:'Karan Gill',title:'Finance Manager',dept:'Finance',loc:'Gurugram',phone:'+91 98110 45673',mgr:'Sameer Joshi'},
  {id:'mk',name:'Meera Krishnan',title:'Payroll Specialist',dept:'Finance',loc:'Bengaluru',phone:'+91 98860 77120',mgr:'Karan Gill'},
  {id:'dm',name:'Divya Menon',title:'QA Lead',dept:'Quality',loc:'Chennai',phone:'+91 98410 22913',mgr:'Sameer Joshi'},
  {id:'sj',name:'Sameer Joshi',title:'Chief Technology Officer',dept:'Leadership',loc:'Bengaluru',phone:'+91 98200 10001',mgr:'Board'},
].map(p=>({...p,initials:p.name.split(' ').map(w=>w[0]).join(''),color:DEPT_COLOR[p.dept],email:p.name.toLowerCase().replace(' ','.')+'@widedrop.com',reportsTo:p.mgr}));
const ANN = [
  {id:1,pinned:true,dept:'People Ops',date:'26 Sep 2026',title:'Holiday schedule: Dussehra and Diwali',by:'Ananya Bose · People Ops',body:['Offices are closed on Tuesday 20 October (Dussehra) and Monday 9 November (Diwali, observed). Sunday 8 November can be taken as a restricted holiday by teams on weekend rotation.','Please submit leave requests around these dates by 10 October so managers can plan coverage.']},
  {id:2,pinned:false,dept:'Finance',date:'24 Sep 2026',title:'Expense claim cut-off is now the 25th of every month',by:'Karan Gill · Finance',body:['Starting October, claims approved by the 25th are reimbursed with that month’s salary. Claims approved later roll into the next payroll.','Travel booked through the travel desk is settled directly and does not need a claim.']},
  {id:3,pinned:false,dept:'Leadership',date:'22 Sep 2026',title:'Q2 town hall — Thursday 8 October, 4:00 PM IST',by:'Sameer Joshi · CTO',body:['Sameer and the leadership team will walk through Q2 results and H2 priorities, followed by open Q&A.','Submit questions anonymously through the Help desk under “Town hall” until 6 October.']},
  {id:4,pinned:false,dept:'Benefits',date:'15 Sep 2026',title:'Health insurance renewed with ICICI Lombard',by:'Ananya Bose · People Ops',body:['Coverage stays at ₹5,00,000 family floater with no change in premium. The maternity limit rises to ₹75,000 and room-rent caps are removed.','New e-cards are available under Benefits from 1 October. Cashless claims continue to work with your existing card until then.']},
  {id:5,pinned:false,dept:'Workplace',date:'8 Sep 2026',title:'Ecospace Tower B parking closed 1 – 15 October',by:'Facilities',body:['Tower B basement parking is closed for waterproofing. Please use Tower A basement levels 2 and 3.','Shuttles from Bellandur and HSR Layout run every 20 minutes between 8 and 11 AM.']},
  {id:6,pinned:false,dept:'IT & Security',date:'1 Sep 2026',title:'Information Security Policy v4.2 published',by:'IT & Security',body:['Multi-factor authentication becomes mandatory on all company SaaS tools from 1 October.','Please read and acknowledge the updated policy under Policies by 15 October.']},
];
const TK0 = [
  {id:'HD-4821',subject:'Form 16 (FY 2025–26) shows an incorrect PAN',cat:'Payroll & tax',meta:'Meera Krishnan · updated 2 days ago',status:chip('In progress','amber')},
  {id:'HD-4790',subject:'GitHub organisation access for new joiner',cat:'IT & access',meta:'Resolved 12 Sep',status:chip('Resolved','green')},
  {id:'HD-4712',subject:'Add newborn dependent to health insurance',cat:'Benefits',meta:'Resolved 28 Aug',status:chip('Resolved','green')},
];
const FAQ = [
  {q:'How do I download my Form 16?',a:'Go to Tax slips → Form 16 and pick the financial year. Part A and Part B come as one PDF, digitally signed by Widedrop.'},
  {q:'Why does my TDS change between months?',a:'TDS is recomputed every month on your projected annual income, including incentives and arrears. A one-off payment raises that month’s deduction.'},
  {q:'When are expense claims reimbursed?',a:'Claims approved by the 25th are paid with that month’s salary. Later approvals roll into the next payroll.'},
  {q:'How do I change my bank account?',a:'Open My profile → Bank & statutory → Request a change and upload a cancelled cheque. Payroll verifies within 2 working days.'},
];
const APR0 = [
  {id:1,who:'Neha Kulkarni',ini:'NK',kind:chip('Leave','blue'),title:'Earned leave · 5 – 9 Oct 2026 (5 days)',sub:'Family wedding in Kolkata · Balance after: 9.5 days',when:'Requested 27 Sep'},
  {id:2,who:'Rahul Verma',ini:'RV',kind:chip('Expense','amber'),title:'EXP-2287 · ₹3,240 · Travel',sub:'Cab fare, Pune office visit · Bills attached',when:'Requested 26 Sep'},
  {id:4,who:'Neha Kulkarni',ini:'NK',kind:chip('Expense','amber'),title:'EXP-2280 · ₹1,299 · Remote work',sub:'Internet bill, August · Within ₹1,500 cap',when:'Requested 24 Sep'},
];
const HIS0 = [
  {id:11,who:'Rahul Verma',ini:'RV',kind:chip('Leave','blue'),title:'Comp-off · 2 Sep 2026 (1 day)',when:'Approved 1 Sep',status:chip('Approved','green')},
  {id:12,who:'Farhan Qureshi',ini:'FQ',kind:chip('Leave','blue'),title:'Sick leave · 26 – 27 Aug 2026 (2 days)',when:'Approved 26 Aug',status:chip('Approved','green')},
];
const TEAM_TONE = {'Available':'green','On leave':'amber'};
const fmtD = d => d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});

class Component extends DCLogic {
  shellRef = React.createRef();
  mainRef = React.createRef();
  state = {
    screen:'home', autoCompact:false, narrow:false, menuOpen:false, notifOpen:false, toast:null, query:'',
    payslip:0, policy:1, ack:{}, ptab:'personal',
    leaves:LEAVES0, lf:{type:'Earned leave',from:'',to:'',reason:''}, lfErr:'',
    expenses:EXP0, efOpen:false, ef:{cat:'Travel',amount:'',date:'',desc:''}, efErr:'',
    letters:LET0, letterType:'Employment verification letter', addressee:'',
    dirQ:'', person:null,
    ann:0, faq:-1,
    tickets:TK0, tf:{cat:'Payroll & tax',subject:'',desc:''}, tfErr:'',
    approvals:APR0, history:HIS0, apprTab:'pending',
  };
  componentDidMount(){
    const el=this.shellRef.current, mn=this.mainRef.current;
    if(window.ResizeObserver){
      this.ro=new ResizeObserver(entries=>{ const upd={}; entries.forEach(e=>{ if(e.target===el){ const c=e.contentRect.width<880; if(c!==this.state.autoCompact) upd.autoCompact=c; } if(e.target===mn){ const n=e.contentRect.width<820; if(n!==this.state.narrow) upd.narrow=n; } }); if(Object.keys(upd).length) this.setState(upd); });
      el&&this.ro.observe(el); mn&&this.ro.observe(mn);
    }
  }
  componentWillUnmount(){ this.ro&&this.ro.disconnect(); clearTimeout(this.tt); }
  go=(id,extra)=>{ this.setState({screen:id,menuOpen:false,notifOpen:false,query:'',...(extra||{})}); requestAnimationFrame(()=>{ if(this.mainRef.current) this.mainRef.current.scrollTop=0; }); };
  toast=msg=>{ clearTimeout(this.tt); this.setState({toast:msg}); this.tt=setTimeout(()=>this.setState({toast:null}),2600); };
  field=(form,key)=>e=>{ const v=e.target.value; this.setState(s=>({[form]:{...s[form],[key]:v},[form==='lf'?'lfErr':form==='ef'?'efErr':'tfErr']:''})); };
  submitLeave=()=>{
    const f=this.state.lf; if(!f.from||!f.to) return this.setState({lfErr:'Choose both a start and an end date.'});
    const a=new Date(f.from), b=new Date(f.to); if(b<a) return this.setState({lfErr:'End date must be on or after the start date.'});
    let days=0; for(let d=new Date(a); d<=b; d.setDate(d.getDate()+1)){ const w=d.getDay(); if(w!==0&&w!==6) days++; }
    if(!days) return this.setState({lfErr:'Those dates fall on a weekend.'});
    const range = a.getTime()===b.getTime()? fmtD(a) : fmtD(a)+' – '+fmtD(b);
    this.setState(s=>({leaves:[{id:Date.now(),type:f.type,range,days:days+(days>1?' days':' day'),note:f.reason.trim()||'Awaiting Arjun Malhotra',status:chip('Pending','amber'),pending:true},...s.leaves],lf:{type:'Earned leave',from:'',to:'',reason:''},lfErr:''}));
    this.toast('Leave request sent to Arjun Malhotra');
  };
  submitExpense=()=>{
    const f=this.state.ef, amt=Number(f.amount);
    if(!amt||amt<=0) return this.setState({efErr:'Enter the amount spent.'});
    if(!f.date) return this.setState({efErr:'Add the date of spend.'});
    if(!f.desc.trim()) return this.setState({efErr:'Describe the expense so Finance can match the bill.'});
    const id='EXP-'+(2291+this.state.expenses.filter(x=>x.k==='new').length+4);
    this.setState(s=>({expenses:[{id,title:f.desc.trim(),cat:f.cat,date:fmtD(new Date(f.date)),amt,status:chip('Awaiting approval','amber'),k:'new'},...s.expenses],ef:{cat:'Travel',amount:'',date:'',desc:''},efErr:'',efOpen:false}));
    this.toast(id+' submitted for approval');
  };
  submitTicket=()=>{
    const f=this.state.tf; if(!f.subject.trim()) return this.setState({tfErr:'Add a one-line subject.'});
    const id='HD-'+(4830+this.state.tickets.length);
    this.setState(s=>({tickets:[{id,subject:f.subject.trim(),cat:f.cat,meta:'Opened just now · unassigned',status:chip('Open','amber')},...s.tickets],tf:{cat:'Payroll & tax',subject:'',desc:''},tfErr:''}));
    this.toast(id+' raised · first response within 1 working day');
  };
  requestLetter=()=>{
    const {letterType,addressee}=this.state;
    this.setState(s=>({letters:[{id:Date.now(),type:letterType,req:'29 Sep 2026',note:addressee.trim()?'Addressed to '+addressee.trim():'General purpose',status:chip('Processing','amber'),issued:false},...s.letters],addressee:''}));
    this.toast(letterType+' requested · ready within 1 working day');
  };
  decide=(id,ok)=>{
    const a=this.state.approvals.find(x=>x.id===id); if(!a) return;
    this.setState(s=>({approvals:s.approvals.filter(x=>x.id!==id),history:[{...a,when:(ok?'Approved':'Rejected')+' just now',status:chip(ok?'Approved':'Rejected',ok?'green':'red')},...s.history]}));
    this.toast((ok?'Approved · ':'Rejected · ')+a.who+' has been notified');
  };
  renderVals(){
    const s=this.state, vp=this.props.viewport??'Auto', role=this.props.role??'Manager', collapsed=!!(this.props.sidebarCollapsed??false);
    const isManager=role==='Manager', mobileFrame=vp==='Mobile';
    const compact = mobileFrame?true: vp==='Desktop'?false: s.autoCompact;
    const stack = compact || s.narrow;
    const screen = (s.screen==='approvals'&&!isManager)?'home':s.screen;
    const pendingCount=s.approvals.length;
    const navItems = NAV.filter(n=>isManager||n.id!=='approvals').map(n=>{ const active=n.id===screen; return {...n,active,go:()=>this.go(n.id),bg:active?'#1B365D':'transparent',hoverBg:active?'#1B365D':'#1A2538',color:active?'#FFFFFF':'#A9B4C7',iconColor:active?'#9CC2FF':'#7C8AA3',badge:n.id==='approvals'?pendingCount:0}; });
    const groups=[...new Set(navItems.map(n=>n.group))].map(g=>({name:g,items:navItems.filter(n=>n.group===g)}));
    const tabs=[...['home','payslips','leave',isManager?'approvals':'profile'].map(id=>navItems.find(n=>n.id===id)).map(n=>({label:n.label,icon:n.icon,go:n.go,color:n.active?'#9CC2FF':'#7C8AA3'})),{label:'More',icon:I.menu,go:()=>this.setState({menuOpen:true}),color:s.menuOpen?'#9CC2FF':'#7C8AA3'}];
    const q=s.query.trim().toLowerCase();
    let results=[];
    if(q){
      results=[
        ...navItems.filter(n=>n.label.toLowerCase().includes(q)).map(n=>({kind:'Module',label:n.label,sub:n.group,go:n.go})),
        ...PEOPLE.filter(p=>(p.name+' '+p.title+' '+p.dept).toLowerCase().includes(q)).slice(0,4).map(p=>({kind:'Person',label:p.name,sub:p.title,go:()=>this.go('directory',{person:p.id,dirQ:''})})),
        ...POLICIES.filter(p=>p.name.toLowerCase().includes(q)).slice(0,3).map(p=>({kind:'Policy',label:p.name,sub:p.ver,go:()=>this.go('policies',{policy:POLICIES.indexOf(p)})})),
        ...PAYSLIPS.filter(p=>p.month.toLowerCase().includes(q)).slice(0,3).map(p=>({kind:'Payslip',label:p.month,sub:p.netFmt,go:()=>this.go('payslips',{payslip:PAYSLIPS.indexOf(p)})})),
      ].slice(0,8);
      if(!results.length) results=[{kind:'',label:'No matches for “'+s.query+'”',sub:'',go:()=>{}}];
    }
    const hour=new Date().getHours(), greeting=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';
    const todos=[];
    POLICIES.filter(p=>!p.ack&&!s.ack[p.id]).forEach(p=>todos.push({title:'Acknowledge '+p.name+' '+p.ver,sub:'Due '+p.due+' · '+p.owner,action:'Review',dot:'#F5C46B',go:()=>this.go('policies',{policy:POLICIES.indexOf(p)})}));
    if(isManager&&pendingCount) todos.push({title:pendingCount+(pendingCount>1?' approvals':' approval')+' waiting on you',sub:'Leave and expense requests from your team',action:'Review',dot:'#9CC2FF',go:()=>this.go('approvals')});
    const team=PEOPLE.filter(p=>p.rel==='report').map(p=>({...p,status:chip(p.today,TEAM_TONE[p.today])}));
    const sel=PAYSLIPS[s.payslip]||PAYSLIPS[0];
    const payslips=PAYSLIPS.map((p,i)=>({...p,select:()=>this.setState({payslip:i}),bg:i===s.payslip?'#1B365D':'transparent',hoverBg:i===s.payslip?'#1B365D':'#1D2A42'}));
    const polStatus=p=>(p.ack||s.ack[p.id])?chip('Acknowledged','green'):chip('Pending','amber');
    const policies=POLICIES.map((p,i)=>({...p,status:polStatus(p),select:()=>this.setState({policy:i}),bg:i===s.policy?'#1B365D':'transparent',hoverBg:i===s.policy?'#1B365D':'#1D2A42'}));
    const polRaw=POLICIES[s.policy]||POLICIES[0];
    const pol={...polRaw,isPending:!polRaw.ack&&!s.ack[polRaw.id],isAcked:!!(polRaw.ack||s.ack[polRaw.id]),ackDate:polRaw.ack||'29 Sep 2026'};
    const policyPendingCount=POLICIES.filter(p=>!p.ack&&!s.ack[p.id]).length;
    const leaves=s.leaves.map(l=>({...l,withdraw:()=>{this.setState(st=>({leaves:st.leaves.filter(x=>x.id!==l.id)}));this.toast('Request withdrawn');}}));
    const benefits=BENEFITS.map(b=>({...b,act:()=>b.go?this.go(b.go,{efOpen:true}):this.toast(b.toast)}));
    const expenses=s.expenses.map(x=>({...x,amtFmt:inr(x.amt),noteFmt:x.note?' · '+x.note:''}));
    const sum=k=>s.expenses.filter(x=>x.k===k).reduce((a,x)=>a+x.amt,0);
    const pendN=s.expenses.filter(x=>x.k==='pending'||x.k==='new').length;
    const expStats=[
      {k:'Awaiting approval',v:inr(sum('pending')+sum('new')),sub:pendN+(pendN===1?' claim':' claims')+' with Arjun Malhotra'},
      {k:'Approved · paying 30 Sep',v:inr(sum('approved')),sub:'With September salary'},
      {k:'Reimbursed FY 2026–27',v:inr(sum('paid')),sub:'4 claims since April'},
    ];
    const letters=s.letters.map(l=>({...l,dl:()=>this.toast('Downloading '+l.type+'.pdf')}));
    const docs=DOCS.map(d=>({...d,dl:()=>this.toast('Downloading '+d.name)}));
    const dq=s.dirQ.trim().toLowerCase();
    const selectPerson=id=>()=>this.setState({person:id});
    const people=PEOPLE.filter(p=>!dq||(p.name+' '+p.title+' '+p.dept+' '+p.loc).toLowerCase().includes(dq)).map(p=>({...p,select:selectPerson(p.id)}));
    const personRaw=PEOPLE.find(p=>p.id===s.person);
    const person=personRaw||PEOPLE[0];
    const lineRaw=[PEOPLE[0],PEOPLE[1],...PEOPLE.filter(p=>p.rel==='report')];
    const line=lineRaw.map((p,i)=>({...p,rel:p.rel==='manager'?'Your manager':p.rel==='you'?'You':'Reports to you',arrow:i<lineRaw.length-1&&(i<1||i>=1&&i<2),select:selectPerson(p.id),bg:s.person===p.id?'#1B365D':'#121B2B',border:s.person===p.id?'#1B365D':'#263247'}));
    const anns=ANN.map((a,i)=>({...a,select:()=>this.setState({ann:i}),bg:i===s.ann?'#1B365D':'transparent',hoverBg:i===s.ann?'#1B365D':'#1D2A42'}));
    const annSel=ANN[s.ann]||ANN[0];
    const homeAnns=ANN.slice(0,3).map(a=>({...a,open:()=>this.go('announcements',{ann:ANN.indexOf(a)})}));
    const faqs=FAQ.map((f,i)=>({...f,open:s.faq===i,rot:s.faq===i?'180deg':'0deg',toggle:()=>this.setState({faq:s.faq===i?-1:i})}));
    const pending=s.approvals.map(a=>({...a,approve:()=>this.decide(a.id,true),reject:()=>this.decide(a.id,false)}));
    const ptabs=PTABS.map(([id,label])=>({id,label,go:()=>this.setState({ptab:id}),color:s.ptab===id?'#F2F5FA':'#7C8AA3',border:s.ptab===id?'#6EA8FF':'transparent'}));
    const pfields=(PROFILE[s.ptab]||[]).map(([k,v])=>({k,v}));
    const notifs=[
      {text:'Your payslip for August 2026 is ready to download.',time:'31 Aug · Payroll',dot:'#5EDBA0',go:()=>this.go('payslips',{payslip:0})},
      {text:'Neha Kulkarni requested earned leave for 5 – 9 Oct.',time:'27 Sep · Approvals',dot:'#9CC2FF',go:()=>this.go(isManager?'approvals':'home')},
      {text:'Information Security Policy v4.2 needs your acknowledgement by 15 Oct.',time:'1 Sep · IT & Security',dot:'#F5C46B',go:()=>this.go('policies',{policy:1})},
    ];
    const set=(k,v)=>()=>this.setState({[k]:v});
    return {
      framePad:mobileFrame?'28px 16px':'0', shellMax:mobileFrame?'390px':'none', shellH:mobileFrame?'844px':'100vh', shellRadius:mobileFrame?'40px':'0', shellBorder:mobileFrame?'1px solid #2A3548':'0',
      shellRef:this.shellRef, mainRef:this.mainRef, compact, desktop:!compact, showSidebar:!compact, sideW:collapsed?'72px':'248px', sideLabels:!collapsed,
      groups, tabs, allNav:navItems, screenTitle:TITLES[screen], contentPad:compact?'20px 16px 32px':'28px 32px 40px',
      splitCols:stack?'1fr':'340px minmax(0,1fr)', formCols:stack?'1fr':'380px minmax(0,1fr)', calCols:stack?'1fr':'minmax(0,1fr) 340px', apprCols:stack?'1fr':'minmax(0,1fr) 320px',
      query:s.query, setQuery:e=>this.setState({query:e.target.value,notifOpen:false}), hasResults:!!q, results,
      notifOpen:s.notifOpen, toggleNotif:()=>this.setState({notifOpen:!s.notifOpen,query:''}), notifs,
      menuOpen:s.menuOpen, closeMenu:()=>this.setState({menuOpen:false}), stop:e=>e.stopPropagation(),
      toast:s.toast, toastBottom:compact?'86px':'28px',
      isHome:screen==='home', isPayslips:screen==='payslips', isTax:screen==='tax', isProfile:screen==='profile', isPolicies:screen==='policies', isLeave:screen==='leave', isBenefits:screen==='benefits', isExpenses:screen==='expenses', isDocuments:screen==='documents', isDirectory:screen==='directory', isAnnouncements:screen==='announcements', isHelp:screen==='help', isApprovals:screen==='approvals'&&isManager,
      goLeave:()=>this.go('leave'), goNewExpense:()=>this.go('expenses',{efOpen:true}), goDocuments:()=>this.go('documents'), goHelp:()=>this.go('help'), goPayslips:()=>this.go('payslips'), goApprovals:()=>this.go('approvals'), goAnnouncements:()=>this.go('announcements'), goDirectory:()=>this.go('directory'), goProfile:()=>this.go('profile'),
      greeting, todos, hasTodos:todos.length>0, todoCount:todos.length,
      latest:PAYSLIPS[0], latestNet:PAYSLIPS[0].netFmt, downloadLatest:()=>this.toast('Downloading Payslip_Aug-2026.pdf'),
      balTop:BAL.slice(0,3), balances:BAL, isManager, pendingCount, pendingLabel:pendingCount===1?'request awaiting your action':'requests awaiting your action', pendingPreview:s.approvals.slice(0,2), homeAnns, holidays:HOL, team,
      ytd:YTD, payslips, sel, downloadSel:()=>this.toast('Downloading Payslip_'+sel.month.replace(' ','-')+'.pdf'), emailSel:()=>this.toast('Payslip for '+sel.month+' sent to priya.raghavan@widedrop.com'),
      quarters:TAXQ, form16:FORM16.map(f=>({...f,dl:()=>this.toast('Downloading '+f.file)})), updateDecl:()=>this.toast('Declaration window opens 1 Dec 2026'), compareRegime:()=>this.toast('Old regime would cost ₹18,240 more this year'),
      ptabs, pfields, pnote:PNOTES[s.ptab], requestChange:()=>this.toast('Change request opened with People Ops · HD-'+(4830+s.tickets.length)),
      policies, pol, policyPendingCount, ackPolicy:()=>{this.setState(st=>({ack:{...st.ack,[polRaw.id]:true}}));this.toast(polRaw.name+' acknowledged');}, dlPolicy:()=>this.toast('Downloading '+polRaw.name+' '+polRaw.ver+'.pdf'),
      lf:s.lf, setLeaveType:this.field('lf','type'), setLeaveFrom:this.field('lf','from'), setLeaveTo:this.field('lf','to'), setLeaveReason:this.field('lf','reason'), lfErr:s.lfErr, hasLfErr:!!s.lfErr, submitLeave:this.submitLeave, leaves,
      benefits, dependents:DEPENDENTS, addDependent:()=>this.toast('Dependent additions open during the enrolment window · 1 – 15 Apr'),
      efOpen:s.efOpen, toggleEf:()=>this.setState({efOpen:!s.efOpen,efErr:''}), efButton:s.efOpen?'Close':'New claim', ef:s.ef, setEfCat:this.field('ef','cat'), setEfAmount:this.field('ef','amount'), setEfDate:this.field('ef','date'), setEfDesc:this.field('ef','desc'), efErr:s.efErr, hasEfErr:!!s.efErr, submitExpense:this.submitExpense, attachBill:()=>this.toast('Bill upload opens your files'), expenses, expStats,
      letterType:s.letterType, setLetterType:e=>this.setState({letterType:e.target.value}), addressee:s.addressee, setAddressee:e=>this.setState({addressee:e.target.value}), requestLetter:this.requestLetter, letters, docs,
      dirQ:s.dirQ, setDirQ:e=>this.setState({dirQ:e.target.value}), person, hasPerson:!!personRaw, closePerson:set('person',null), copyEmail:()=>{try{navigator.clipboard&&navigator.clipboard.writeText(person.email);}catch(e){} this.toast(person.email+' copied');}, people, hasPeople:people.length>0, noPeople:people.length===0, showLine:!dq, line,
      anns, annSel,
      tf:s.tf, setTfCat:this.field('tf','cat'), setTfSubject:this.field('tf','subject'), setTfDesc:this.field('tf','desc'), tfErr:s.tfErr, hasTfErr:!!s.tfErr, submitTicket:this.submitTicket, tickets:s.tickets, faqs,
      showPending:s.apprTab==='pending', showHistory:s.apprTab==='history', showPendingTab:set('apprTab','pending'), showHistoryTab:set('apprTab','history'),
      pendTabBg:s.apprTab==='pending'?'#1B365D':'transparent', pendTabFg:s.apprTab==='pending'?'#FFFFFF':'#A9B4C7', histTabBg:s.apprTab==='history'?'#1B365D':'transparent', histTabFg:s.apprTab==='history'?'#FFFFFF':'#A9B4C7',
      pending, noPending:pending.length===0, history:s.history,
    };
  }
}
