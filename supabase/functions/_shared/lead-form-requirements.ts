// Meta Page leadgen_forms reference: cover_photo_id is a numeric string on creation;
// LeadGenContextCard SDK: read-back cover_photo is a Photo object, not cover_photo_id.
// question_page_custom_headline maps to Ads Manager Contact information Description:
// Casey confirmed Weyers v3 copied this field from v2 and it appears in that box (2026-10-25).
export const LEAD_FORM_READ_FIELDS = 'id,name,status,page,context_card,question_page_custom_headline';
export const LEAD_FORM_DESCRIPTION = 'Your information will be used to contact you about our offers.';
export const FORM_IMAGE_INSTRUCTION = `Every replacement form must have its background image enabled using the main ad image, never a generic image. Include context_card and question_page_custom_headline in proposed_form. question_page_custom_headline must be exactly "${LEAD_FORM_DESCRIPTION}". Never omit or rewrite this required text.`;

export function proposedFormRequirements(imageUrl: string, pageId: string, proposed: any, businessName: string) {
  if (!imageUrl) throw new Error('Lead form needs a main ad image for its background; no image is saved for this campaign');
  if (!pageId) throw new Error('Lead form needs the connected Facebook Page');
  return {
    context_card: {
      background_image_enabled: true,
      cover_photo_id: null, // assigned by the builder AFTER the unpublished Page-photo upload
      cover_photo_url: imageUrl,
      cover_photo_source: 'main_ad_image',
      photo_upload: { method: 'POST', endpoint: `${pageId}/photos`, params: { url: imageUrl, published: false } },
      id_rejection_fallback: { field: 'context_card.cover_photo', encoding: 'multipart/form-data', source_url: imageUrl, permission: 'pages_manage_posts' },
    },
    question_page_custom_headline: LEAD_FORM_DESCRIPTION,
  };
}

export function leadFormChecks(form: any, proposed: any = null) {
  const coverId = String(form?.context_card?.cover_photo?.id ?? form?.context_card?.cover_photo_id ?? '').trim();
  const expectedId = String(proposed?.context_card?.cover_photo_id ?? '').trim();
  const description = String(form?.question_page_custom_headline ?? '');
  return [
    { what: 'lead form background image', expected: expectedId || 'numeric photo ID', found: coverId || 'missing', ok: /^\d+$/.test(coverId) && (!expectedId || coverId === expectedId) },
    { what: 'lead form question-page text', expected: LEAD_FORM_DESCRIPTION, found: description || 'missing', ok: description === LEAD_FORM_DESCRIPTION },
  ];
}