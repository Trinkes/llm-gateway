-- [fork] W17: request units. `method` is the request kind; `units` holds the
-- count of the kind's own unit when that unit is not tokens (image rows store
-- the requested image count). NULL for token kinds and for older rows.
ALTER TABLE request_metrics ADD COLUMN units INTEGER;
