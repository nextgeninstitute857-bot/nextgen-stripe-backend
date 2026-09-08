// A shared question keeps one content identity. Reviewed clinical paths are
// bound to the exact approved source used for delivery, never a requested label.
export const NCLEX_VARIANT_TAXONOMY_KIND = 'nclex_variant_paths_v1';
export const NCLEX_SOURCE_BINDING_FIELDS = ['collection_id', 'collection_title', 'collection_key', 'source_provider', 'source_profile', 'source_namespace', 'source_item_id', 'source_file'];

export function nclexTaxonomySourceBinding(source, variant) {
  return { variant, ...Object.fromEntries(NCLEX_SOURCE_BINDING_FIELDS.map(key => [key,
    key === 'source_file' ? String(source[key] || '').split(/[\\/]/).at(-1) : String(source[key] || '')])) };
}

export function sortNclexTaxonomyBindings(bindings) {
  return [...bindings].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// This CASE adds no extra database join. Ordinary and shared-common mappings
// retain their current path. A new or changed source falls back to its original
// broad taxonomy until its provenance is reviewed again.
export function contentNclexDeliveryTaxonomySql(q = 'q', a = 'a', c = 'c') {
  const source = `jsonb_build_object(
    'collection_id',${a}.collection_id::text,
    'collection_title',COALESCE(${c}.title,''),
    'collection_key',COALESCE(${c}.collection_key,''),
    'source_provider',COALESCE(${c}.source_provider,''),
    'source_profile',COALESCE(${c}.source_profile,''),
    'source_namespace',COALESCE(${a}.source_namespace,''),
    'source_item_id',COALESCE(${a}.source_item_id,''),
    'source_file',regexp_replace(COALESCE(${a}.source_data->>'import_source_file',''),${String.raw`'^.*[\\/]'`},''))`;
  return `CASE WHEN ${q}.exam_track='nclex'
      AND ${q}.taxonomy->>'kind'='${NCLEX_VARIANT_TAXONOMY_KIND}'
      AND ${q}.taxonomy->>'source'='question_override'
      AND ${q}.taxonomy->>'review_status'='approved'
    THEN COALESCE((SELECT (${q}.taxonomy->'paths'->(binding->>'variant')) || jsonb_build_object(
        'source','question_override','review_status','approved',
        'review_id',${q}.taxonomy->'review_id','override_id',${q}.taxonomy->'override_id')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${q}.taxonomy->'source_bindings')='array'
        THEN ${q}.taxonomy->'source_bindings' ELSE '[]'::jsonb END) binding
      WHERE binding->>'variant' IN ('nclex_rn','nclex_pn')
        AND binding-'variant'=${source}
        AND jsonb_typeof(${q}.taxonomy->'paths'->(binding->>'variant'))='object'
      LIMIT 1), ${q}.taxonomy->'fallback_taxonomy', '{}'::jsonb)
    ELSE ${q}.taxonomy END`;
}
