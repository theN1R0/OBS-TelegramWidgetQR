// Public rich-post previews currently contain plain text, not the original
// article blocks/entities. Paragraphs and a lead heading are a presentation
// fallback only; never infer inline emphasis or interpret this text as HTML.
export function telegramExcerptParagraphs(post) {
  if (!post.previewOnly || post.service || post.content?.length) return [];
  const paragraphs = String(post.text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return paragraphs.length > 1 ? paragraphs : [];
}
