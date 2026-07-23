export type Company = {
  id: string;
  slug: string;
  name: string;
  domain: string;
  description: string;
  foundedYear: number | null;
  headquarters: string;
  employeeRange: string;
  industry: string;
  stage: string;
  fundingMode: string;
  lifecycleStatus: string;
  hiringScore: number;
  evidenceConfidence: number;
  latestFundingLabel: string;
  latestFundingDate: string | null;
  careersUrl: string;
  sourceUrl: string;
  openJobCount: number;
  lastVerifiedAt: string;
};

export type Job = {
  id: string;
  companyId: string;
  externalId: string;
  title: string;
  roleFamily: string;
  location: string;
  remoteStatus: string;
  employmentType: string;
  compensation: string;
  canonicalUrl: string;
  source: string;
  status: string;
  firstSeenAt: string;
  lastVerifiedAt: string;
  closedAt: string | null;
  summary: string;
  company?: Company;
};

export type ChangeEvent = {
  id: string;
  entityType: string;
  entityId: string;
  changeType: string;
  title: string;
  description: string;
  occurredAt: string;
  sourceUrl: string;
};
