-- An annotation can hang on a picture instead of a quote: the picture's place among the document's pictures, the hash of its
-- src, its caption or alt text and an optional spot on it (the `ImageAnchor` of the contract), as one jsonb object. The column is
-- nullable and not backfilled: an annotation without it is a comment on text, as before.

ALTER TABLE factory.annotations ADD COLUMN image jsonb;
