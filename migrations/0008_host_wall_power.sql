-- [fork] W14: wall power from a metering plug (node-exporter textfile metrics).
-- resolution_s 10:  wall_power_w per sample (NULL when the plug reading is
--                   missing or stale); the other three columns NULL.
-- resolution_s 600: wall_power_w = AVG and wall_power_w_max = MAX over ok
--                   rows; wall_samples = ok rows that had a wall reading;
--                   apu_only_power_w = AVG(gpu_power_w) over ok rows without
--                   one, so a bucket the plug only partly covered can price
--                   its APU-only time from those rows alone.
-- Rows written before this migration stay NULL: all their time is APU-only.
ALTER TABLE host_samples ADD COLUMN wall_power_w REAL;
ALTER TABLE host_samples ADD COLUMN wall_power_w_max REAL;
ALTER TABLE host_samples ADD COLUMN wall_samples INTEGER;
ALTER TABLE host_samples ADD COLUMN apu_only_power_w REAL;
