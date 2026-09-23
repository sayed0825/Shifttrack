import { describe, it, expect, inject } from 'vitest';
import { adminClient } from '../setup/env';
import { signInAs } from '../setup/clients';

const fixtures = inject('fixtures');

/**
 * storage.buckets.file_size_limit/allowed_mime_types (0036) — security
 * audit finding 9: neither org-logos nor task-photos ever set these.
 * Both were enforced client-side only. Confirmed live: an arbitrary
 * oversized, non-image blob uploaded to task-photos with zero error.
 *
 * Storage rejections surface as a direct error on the upload call itself
 * (unlike a table RLS block, which can be a silent empty result) — so
 * checking `error` directly here is correct, not the gotcha assert.ts
 * warns about for table writes.
 */
describe('storage buckets — file type and size are enforced server-side', () => {
  it('task-photos rejects a disallowed mime type', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    const path = `${fixtures.orgA.taskItemEmployee1Id}/audit-reject-type.exe`;
    const { error } = await employee1.storage
      .from('task-photos')
      .upload(path, new Blob([new Uint8Array(16)], { type: 'application/x-msdownload' }), {
        contentType: 'application/x-msdownload',
      });
    expect(error).not.toBeNull();
  });

  it('task-photos rejects a file over 10MB', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    const path = `${fixtures.orgA.taskItemEmployee1Id}/audit-reject-size.jpg`;
    const oversized = new Uint8Array(11 * 1024 * 1024);
    const { error } = await employee1.storage
      .from('task-photos')
      .upload(path, new Blob([oversized], { type: 'image/jpeg' }), { contentType: 'image/jpeg' });
    expect(error).not.toBeNull();
  });

  it('task-photos accepts a small JPEG', async () => {
    const employee1 = await signInAs(fixtures.orgA.employee1);
    const path = `${fixtures.orgA.taskItemEmployee1Id}/audit-accept-${Date.now()}.jpg`;
    try {
      const { error } = await employee1.storage
        .from('task-photos')
        .upload(path, new Blob([new Uint8Array(16)], { type: 'image/jpeg' }), { contentType: 'image/jpeg' });
      expect(error).toBeNull();
    } finally {
      await adminClient.storage.from('task-photos').remove([path]);
    }
  });

  it('org-logos rejects a disallowed mime type', async () => {
    const manager = await signInAs(fixtures.orgA.manager);
    const path = `${fixtures.orgA.orgId}/audit-reject-type.gif`;
    const { error } = await manager.storage
      .from('org-logos')
      .upload(path, new Blob([new Uint8Array(16)], { type: 'image/gif' }), { contentType: 'image/gif' });
    expect(error).not.toBeNull();
  });

  it('org-logos rejects a file over 1MB', async () => {
    const manager = await signInAs(fixtures.orgA.manager);
    const path = `${fixtures.orgA.orgId}/audit-reject-size.png`;
    const oversized = new Uint8Array(2 * 1024 * 1024);
    const { error } = await manager.storage
      .from('org-logos')
      .upload(path, new Blob([oversized], { type: 'image/png' }), { contentType: 'image/png' });
    expect(error).not.toBeNull();
  });

  it('org-logos accepts a small PNG', async () => {
    const manager = await signInAs(fixtures.orgA.manager);
    const path = `${fixtures.orgA.orgId}/audit-accept-${Date.now()}.png`;
    try {
      const { error } = await manager.storage
        .from('org-logos')
        .upload(path, new Blob([new Uint8Array(16)], { type: 'image/png' }), { contentType: 'image/png' });
      expect(error).toBeNull();
    } finally {
      await adminClient.storage.from('org-logos').remove([path]);
    }
  });
});
