-- Run after work_item_key_schema.sql with psql -v ON_ERROR_STOP=1.
-- Exercise actual PostgreSQL triggers and constraints; all fixture writes roll back.
BEGIN;
DO $work_key_checks$
DECLARE
  first_key TEXT;
  second_key TEXT;
  explicit_key TEXT;
  namespace TEXT;
  next_number BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM work_items WHERE work_item_key IS NULL) THEN
    RAISE EXCEPTION 'Migration left work without a public reference';
  END IF;
  IF (SELECT prefix FROM work_item_key_namespaces WHERE project_id = 'p-observability') IS DISTINCT FROM 'ORG-OBS' THEN
    RAISE EXCEPTION 'Observability reservation changed';
  END IF;
  INSERT INTO projects (id, name) VALUES ('p-work-key-regression', 'Work-key regression fixture');
  INSERT INTO work_items (id, project_id, type, title)
    VALUES ('wi-work-key-regression-1', 'p-work-key-regression', 'story', 'First fixture')
    RETURNING work_item_key INTO first_key;
  IF first_key IS NULL THEN RAISE EXCEPTION 'Insert did not allocate a key'; END IF;
  UPDATE work_items SET title = 'Renamed fixture', status = 'in_progress' WHERE id = 'wi-work-key-regression-1';
  IF (SELECT work_item_key FROM work_items WHERE id = 'wi-work-key-regression-1') IS DISTINCT FROM first_key THEN
    RAISE EXCEPTION 'Ordinary edit changed a published reference';
  END IF;
  BEGIN
    UPDATE work_items SET work_item_key = first_key || '0' WHERE id = 'wi-work-key-regression-1';
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Published key change was accepted';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    UPDATE work_items SET project_id = 'p-work-key-regression-moved' WHERE id = 'wi-work-key-regression-1';
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Published key was moved to another initiative';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  SELECT prefix INTO namespace FROM work_item_key_namespaces WHERE project_id = 'p-work-key-regression';
  BEGIN
    INSERT INTO work_items (id, project_id, type, title, work_item_key)
      VALUES ('wi-work-key-regression-wrong', 'p-work-key-regression', 'bug', 'Wrong namespace', 'ORG-OBS-9999');
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Foreign namespace was accepted';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  DELETE FROM work_items WHERE id = 'wi-work-key-regression-1';
  INSERT INTO work_items (id, project_id, type, title)
    VALUES ('wi-work-key-regression-2', 'p-work-key-regression', 'bug', 'After deletion')
    RETURNING work_item_key INTO second_key;
  IF first_key = second_key THEN RAISE EXCEPTION 'Deleted key was reused'; END IF;
  explicit_key := namespace || '-30';
  INSERT INTO work_items (id, project_id, type, title, work_item_key)
    VALUES ('wi-work-key-regression-explicit', 'p-work-key-regression', 'epic', 'Reserved fixture', explicit_key);
  SELECT n.next_number INTO next_number FROM work_item_key_namespaces n WHERE project_id = 'p-work-key-regression';
  IF next_number <> 31 THEN RAISE EXCEPTION 'Explicit reservation did not advance the counter'; END IF;
  INSERT INTO work_items (id, project_id, type, title)
    VALUES ('wi-work-key-regression-3', 'p-work-key-regression', 'story', 'After reservation')
    RETURNING work_item_key INTO second_key;
  IF second_key IS DISTINCT FROM namespace || '-31' THEN RAISE EXCEPTION 'Next allocation ignored the reservation'; END IF;
  RAISE NOTICE 'Public keys: allocation, immutability, namespace, deletion and reservation checks passed';
END;
$work_key_checks$;
ROLLBACK;
