import { z } from 'zod';
export const settingsSchema=z.object({
  recipient_quota:z.number().int().min(1).max(1000),
  cooldown_seconds:z.number().int().min(0).max(86400),
  client_quota:z.number().int().min(1).max(10000),
  device_quota:z.number().int().min(1).max(10000),
  message_ttl_seconds:z.number().int().min(60).max(86400),
  replay_window_hours:z.number().int().min(1).max(720),
  confirmation_cooldown_seconds:z.number().int().min(30).max(86400),
}).strict();
