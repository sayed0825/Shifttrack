-- ============================================================================
-- 0036_storage_bucket_limits.sql
--
-- Security audit finding 9 (2026-09-23) -- confirmed live against a
-- throwaway org + real session before writing this: neither org-logos nor
-- task-photos ever set file_size_limit or allowed_mime_types on
-- storage.buckets. Both were enforced client-side only (org-logos: the
-- 1MB/PNG-JPG-SVG cap noted in 0001_baseline.sql's own comment, never
-- server-side; task-photos: no cap or type check anywhere) -- a direct
-- upload through the Storage API bypassed the client entirely. Confirmed
-- live: an arbitrary oversized, non-image blob uploaded to task-photos
-- with zero error.
--
-- org-logos: matches the client's own documented intent exactly --
-- image/png, image/jpeg, image/svg+xml, capped at 1MB.
--
-- task-photos: the app always compresses to JPEG client-side
-- (src/lib/compressImage.ts, max 1600px, quality 0.85) before upload --
-- but falls back to the ORIGINAL file's type when compression itself
-- fails (createImageBitmap unsupported/corrupt input, e.g. some HEIC
-- cases), so the allowed set stays intentionally broader than
-- image/jpeg alone rather than break that fallback. 10MB comfortably
-- covers an uncompressed phone photo while still capping the "arbitrary
-- size" half of the finding.
-- ============================================================================

begin;

update storage.buckets
set file_size_limit = 1048576, -- 1MB
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/svg+xml']
where id = 'org-logos';

update storage.buckets
set file_size_limit = 10485760, -- 10MB
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/heic', 'image/webp']
where id = 'task-photos';

commit;
