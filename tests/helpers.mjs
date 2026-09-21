import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { nameToEmail } from '../src/lib.js';

function statusEnv() {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8' });
  const env = {};
  for (const line of out.split('\n')) {
    const m = /^(\w+)="?([^"]*)"?$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const ENV = statusEnv();
export const LOCAL_URL = ENV.API_URL;
export const ANON_KEY = ENV.ANON_KEY;
export const SERVICE_KEY = ENV.SERVICE_ROLE_KEY;

export function anon() {
  return createClient(LOCAL_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function admin() {
  return createClient(LOCAL_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function newUser(name, password = 'secret123') {
  const client = anon();
  const { data, error } = await client.auth.signUp({
    email: nameToEmail(name), password, options: { data: { name } },
  });
  if (error) throw error;
  if (!data.session) {
    const r = await client.auth.signInWithPassword({ email: nameToEmail(name), password });
    if (r.error) throw r.error;
  }
  return { client, user: data.user };
}

export async function promote(userId) {
  const { error } = await admin().from('profiles').update({ is_admin: true }).eq('id', userId);
  if (error) throw error;
}

export async function cleanup(userIds) {
  const a = admin();
  try { await a.from('jobs').delete().in('requester_id', userIds); } catch { /* ignore */ }
  try { await a.from('jobs').delete().in('assignee_id', userIds); } catch { /* ignore */ }
  for (const id of userIds) {
    try { await a.auth.admin.deleteUser(id); } catch { /* ignore: may already be deleted */ }
  }
}

export function uniq(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
