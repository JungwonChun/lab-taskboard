import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newUser, cleanup, uniq, admin } from './helpers.mjs';
import { UNCATEGORIZED_ID } from '../src/lib.js';

const created = [];
after(async () => { await cleanup(created); });

test('signup creates a profile row with the given name', async () => {
  const name = uniq('스모크');
  const { client, user } = await newUser(name);
  created.push(user.id);
  const { data, error } = await client.from('profiles').select('*').eq('id', user.id).single();
  assert.equal(error, null);
  assert.equal(data.name, name);
  assert.equal(data.is_admin, false);
});

test('미분류 project is seeded and protected', async () => {
  const { client, user } = await newUser(uniq('시드'));
  created.push(user.id);
  const { data } = await client.from('projects').select('*').eq('id', UNCATEGORIZED_ID).single();
  assert.equal(data.name, '미분류');
  const del = await client.from('projects').delete().eq('id', UNCATEGORIZED_ID).select();
  assert.deepEqual(del.data, []); // RLS: nothing deleted
  const { data: still } = await admin().from('projects').select('id').eq('id', UNCATEGORIZED_ID);
  assert.equal(still.length, 1);
});

test('attachments bucket exists with 20MB limit', async () => {
  const { data } = await admin().storage.getBucket('attachments');
  assert.equal(data.public, false);
  assert.equal(Number(data.file_size_limit), 20971520);
});
