-- [fork] W17: request units. `method` is the request kind; `units` holds the
-- count of the kind's own unit when that unit is not tokens (image rows store
-- the requested image count). NULL for token kinds and for older rows.
ALTER TABLE request_metrics ADD COLUMN units INTEGER;

-- Image rows written before W17 did not record the requested `n`; 1 is the
-- default, so successful ones count as one image each.
UPDATE request_metrics SET units = 1
  WHERE method = 'image' AND status_code < 400 AND units IS NULL;
