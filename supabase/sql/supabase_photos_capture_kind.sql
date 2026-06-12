-- Photos Module — add before/after capture tagging.
-- Punch list closure is inherently a before/after workflow; this lets photos be
-- tagged accordingly and filtered. 'general' covers daily-log and standalone shots.
alter table photos
  add column if not exists capture_kind text not null default 'general'
    check (capture_kind in ('general','before','after'));

create index if not exists photos_capture_kind_idx on photos (capture_kind);
