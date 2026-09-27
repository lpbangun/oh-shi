// A label for the existing ingest gate; this does not change isUsEligible or
// assert that a candidate has verified US work authorization.
export const JOB_ELIGIBILITY = {
  label: "US-eligible incl. global/unspecified remote",
  semantics: "Includes US locations (including onsite) and bare/global/unspecified remote designations; excludes explicitly foreign-only roles. This is not remote-only and not verified US work authorization. Consumers can filter remote_status separately.",
} as const;
