-- An annotation names the occurrence it hangs on, not only the text: the quote's place among its equal passages in the
-- document's text (0-based) and the text just before and after it (the W3C TextQuoteSelector idea). All three are
-- nullable and not backfilled: an annotation without them resolves to the first occurrence of its quote, as before.

ALTER TABLE factory.annotations
  ADD COLUMN occurrence integer CHECK (occurrence IS NULL OR occurrence >= 0),
  ADD COLUMN prefix text,
  ADD COLUMN suffix text;
