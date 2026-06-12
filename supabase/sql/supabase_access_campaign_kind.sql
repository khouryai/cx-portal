-- ============================================================
-- access_campaigns.campaign_kind — standard vs planned closure
--
-- Classifies an access campaign as routine non-revenue access ('standard') or a
-- planned weekend/line closure ('closure') — the larger windows planned ~6 months
-- ahead. Visual classification only (closure campaigns are marked on the cards
-- and stand out on the week/month Access Plan); no scheduling difference.
--
-- Applied live as migration: access_campaign_kind_closure. Idempotent.
-- ============================================================
alter table access_campaigns
  add column if not exists campaign_kind text not null default 'standard';
alter table access_campaigns drop constraint if exists access_campaigns_kind_check;
alter table access_campaigns add constraint access_campaigns_kind_check
  check (campaign_kind in ('standard', 'closure'));
comment on column access_campaigns.campaign_kind is
  'standard = routine non-revenue access; closure = planned weekend/line closure (larger window, planned far ahead). Visual classification only.';
