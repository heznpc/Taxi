import { test, expect } from '@jest/globals';
import { approvalRequestDigest } from '../dist/shared/approval-evidence.js';
test('approval evidence is canonical, target-sensitive and tool-bound', () => {
  const a = approvalRequestDigest('create_reminder', { title: 'private', target: { b: 2, a: 1 } });
  expect(a).toBe(approvalRequestDigest('create_reminder', { target: { a: 1, b: 2 }, title: 'private' }));
  expect(a).not.toBe(approvalRequestDigest('create_reminder', { title: 'private', target: { b: 3, a: 1 } }));
  expect(a).not.toBe(approvalRequestDigest('delete_reminder', { title: 'private', target: { b: 2, a: 1 } }));
  expect(a).toMatch(/^sha256:v1:[a-f0-9]{64}$/); expect(a).not.toContain('private');
});
