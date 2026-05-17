import type { Env } from "../index";

export type UserMode = "normal" | "controlled";

export interface UserSettings {
  mode: UserMode;
  controlledBatchSize: number;
}

const DEFAULTS: UserSettings = { mode: "normal", controlledBatchSize: 1 };

/** Read a user's runtime settings, falling back to defaults if no row exists. */
export async function getUserSettings(
  userId: string,
  env: Env
): Promise<UserSettings> {
  const row = await env.DB.prepare(
    "SELECT mode, controlled_batch_size FROM user_settings WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ mode: UserMode; controlled_batch_size: number }>();

  if (!row) return { ...DEFAULTS };
  return { mode: row.mode, controlledBatchSize: row.controlled_batch_size };
}

export async function isControlled(userId: string, env: Env): Promise<boolean> {
  return (await getUserSettings(userId, env)).mode === "controlled";
}

/** Upsert a user's settings. Either field is optional. */
export async function setUserSettings(
  userId: string,
  env: Env,
  patch: { mode?: UserMode; controlledBatchSize?: number }
): Promise<UserSettings> {
  const current = await getUserSettings(userId, env);
  const mode = patch.mode ?? current.mode;
  const batch = patch.controlledBatchSize ?? current.controlledBatchSize;

  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, mode, controlled_batch_size, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       mode = excluded.mode,
       controlled_batch_size = excluded.controlled_batch_size,
       updated_at = datetime('now')`
  )
    .bind(userId, mode, batch)
    .run();

  return { mode, controlledBatchSize: batch };
}
