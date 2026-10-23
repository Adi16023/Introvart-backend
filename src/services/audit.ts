import type { Db } from "../lib/db";
import { uid } from "../lib/http";

export async function audit(db: Db, actor: string, action: string) {
  await db.auditLog.create({ data: { id: uid("AU"), actor, action } });
}
