-- Keep optimistic flow saves in sync with writes through the opening editor.
CREATE TRIGGER shared_opening_insert AFTER INSERT ON position_opening
WHEN EXISTS (SELECT 1 FROM agent_flow WHERE position_id=NEW.position_id AND json_array_length(canvas_json,'$.opening_layout')>0)
BEGIN
  UPDATE agent_flow SET version=version+1, updated_at=CURRENT_TIMESTAMP WHERE position_id=NEW.position_id;
END;

CREATE TRIGGER shared_opening_update AFTER UPDATE OF seq,kind,content,media_name,delay_ms,status ON position_opening
WHEN (NEW.seq IS NOT OLD.seq OR NEW.kind IS NOT OLD.kind OR NEW.content IS NOT OLD.content OR
      NEW.media_name IS NOT OLD.media_name OR NEW.delay_ms IS NOT OLD.delay_ms OR NEW.status IS NOT OLD.status)
 AND EXISTS (SELECT 1 FROM agent_flow WHERE position_id=NEW.position_id AND json_array_length(canvas_json,'$.opening_layout')>0)
BEGIN
  UPDATE agent_flow SET version=version+1, updated_at=CURRENT_TIMESTAMP WHERE position_id=NEW.position_id;
END;

CREATE TRIGGER shared_opening_delete AFTER DELETE ON position_opening
WHEN EXISTS (SELECT 1 FROM agent_flow WHERE position_id=OLD.position_id AND json_array_length(canvas_json,'$.opening_layout')>0)
BEGIN
  UPDATE agent_flow SET version=version+1, updated_at=CURRENT_TIMESTAMP WHERE position_id=OLD.position_id;
END;
