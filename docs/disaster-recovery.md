# Disaster recovery

## Recovery objectives

Set RPO and RTO according to the evidence-retention and documentation-publication requirements of the target repository. PostgreSQL is the only durable state dependency and must be included in backup policy.

## Restore procedure

1. Stop all `agent-docs` jobs.
2. Restore PostgreSQL to a new isolated instance.
3. Deploy the same application version used at backup time.
4. Run migrations only after the restored database is verified.
5. Run `agent-docs validate`.
6. Run a dry full resynchronization with `agent-docs run --full`.
7. Compare impacts and stored renders before re-enabling publication.

Upstream source can reconstruct projections, but immutable retained snapshots, run history, manual-conflict state, and publication retry records depend on the database backup.
