// 0006 修复：fts_pb_notes 影子表 content 指向错误。
// 背景：0004 的 SQL 冻结进 checksum，不可改写；pb_ 重命名时 fts_pb_notes 的
// content 表漏改（仍指向已不存在的 'notes'）。触发器同步仍工作（直接写索引），
// 但 'rebuild' 会因读不到内容表失败——违反 spec 06 §3 的重建要求，属于
// 索引漂移后无法收敛的真实缺陷。0006 重建影子表与触发器并立即 rebuild。
// checksumInput 只含本文件 SQL（0004 冻结面不动）。

export const PB_NOTES_FTS_FIX_SQL = `
DROP TRIGGER IF EXISTS pb_notes_fts_ai;
DROP TRIGGER IF EXISTS pb_notes_fts_ad;
DROP TRIGGER IF EXISTS pb_notes_fts_au;
DROP TABLE IF EXISTS fts_pb_notes;
CREATE VIRTUAL TABLE fts_pb_notes USING fts5(
  title, body, content='pb_notes', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER pb_notes_fts_ai AFTER INSERT ON pb_notes BEGIN
  INSERT INTO fts_pb_notes(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER pb_notes_fts_ad AFTER DELETE ON pb_notes BEGIN
  INSERT INTO fts_pb_notes(fts_pb_notes, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER pb_notes_fts_au AFTER UPDATE ON pb_notes BEGIN
  INSERT INTO fts_pb_notes(fts_pb_notes, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO fts_pb_notes(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
INSERT INTO fts_pb_notes(fts_pb_notes) VALUES('rebuild');
`;

export function applyPlayableBenchFtsNotesFixV6(db: { exec: (sql: string) => void }): void {
  db.exec(PB_NOTES_FTS_FIX_SQL);
}
