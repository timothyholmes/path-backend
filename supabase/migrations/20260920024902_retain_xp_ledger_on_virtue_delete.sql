-- Deleting a virtue must not delete the XP it earned.
--
-- `xp_ledger` was created with `on delete cascade` on the (virtue_id, user_id)
-- pair, so removing a virtue erased its ledger rows. Two problems with that:
--
--   * api-spec.yml's `DELETE /virtues/{id}` promises "XP already recorded
--     against it in the ledger is retained (the ledger is append-only)", and an
--     append-only table that silently loses rows is not an audit trail.
--   * `profiles.global_xp` is a running total maintained by
--     `calculate_and_award_xp`, never recomputed from the ledger. Cascading the
--     rows away left the profile's total unreconcilable against the ledger that
--     is supposed to explain it.
--
-- `virtue_id` is already nullable — global-only XP (a retrospective review)
-- writes a null — so orphaning the rows is representable. `set null` is scoped
-- to that one column, exactly as `goal_backlog.virtue_id` already does; the
-- pair's `user_id` is NOT NULL and must survive, and MATCH SIMPLE means a null
-- `virtue_id` satisfies the constraint whatever `user_id` holds.
--
-- Untagging routines, goals, sessions, and field logs still cascades: those
-- rows describe a virtue that no longer exists, whereas a ledger row records
-- something that actually happened.

alter table public.xp_ledger
  drop constraint if exists xp_ledger_virtue_id_user_id_fkey;

alter table public.xp_ledger
  add constraint xp_ledger_virtue_id_user_id_fkey
  foreign key (virtue_id, user_id) references public.virtues (id, user_id)
  on delete set null (virtue_id);
