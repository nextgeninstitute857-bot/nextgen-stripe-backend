import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAylaQbankFacetTree, mergeAylaQbankFacets, normalizeAylaQbankSelectionPaths, normalizeAylaQbankUsageHistory } from '../lib/aylamed-qbank-facets.js';
import { normalizeAylaQbankFilters, createAylaQbankSession } from '../lib/aylamed-qbank.js';
import { contentQbankSelectionPredicate } from '../lib/content-registry-postgres.js';

const id = '12345678-1234-4123-8123-123456789abc';
const history = { seenQuestionIds: [id], incorrectQuestionIds: [], markedQuestionIds: [] };
const base = { system_key:'cardio',system_label:'Cardiovascular',subsystem_key:'rhythm',subsystem_label:'Rhythm disorders',
  topic_key:'af',topic_label:'Atrial fibrillation',subtopic_key:'rate',subtopic_label:'Rate control',question_count:12,mapping_status:'reviewed' };

test('omitted selection preserves legacy use, explicit empty selection remains empty',()=>{
  assert.equal(normalizeAylaQbankSelectionPaths(undefined),undefined);
  assert.deepEqual(normalizeAylaQbankFilters({selection_paths:[]}).selection_paths,[]);
  assert.equal(contentQbankSelectionPredicate().values[5],null);
  assert.equal(contentQbankSelectionPredicate({filters:{selection_paths:[]}}).values[5],'[]');
  for(const paths of [null,'cardio',[{}],[{topic_key:'af'}],[{system_key:['cardio']}],[{system_key:'cardio',subtopic_key:'rate'}],[{system_key:'cardio',unknown:'x'}]]) {
    assert.throws(()=>normalizeAylaQbankSelectionPaths(paths),error=>error.code==='INVALID_QBANK_SELECTION');
  }
});

test('multi-branch paths are preserved and overlapping descendants collapse to selected ancestors',()=>{
  assert.deepEqual(normalizeAylaQbankSelectionPaths([
    {system_key:'cardio',subsystem_key:'rhythm',topic_key:'af'},
    {system_key:'pulmonary',subsystem_key:'airway'},
    {system_key:'cardio'}, {system_key:'cardio'},
  ]),[{system_key:'pulmonary',subsystem_key:'airway'},{system_key:'cardio'}]);
  assert.throws(()=>normalizeAylaQbankFilters({system_key:['cardio','pulmonary']}),/use selection_paths/);
});

test('usage filters fail closed when scoped history is absent or malformed, without truncating legitimate history',()=>{
  assert.throws(()=>normalizeAylaQbankUsageHistory(undefined,'incorrect'),error=>error.code==='QBANK_HISTORY_REQUIRED');
  assert.throws(()=>normalizeAylaQbankUsageHistory({seenQuestionIds:[]},'unused'),error=>error.code==='QBANK_HISTORY_REQUIRED');
  assert.throws(()=>normalizeAylaQbankUsageHistory({...history,markedQuestionIds:['bad']},'marked'),error=>error.code==='INVALID_QBANK_HISTORY');
  assert.deepEqual(normalizeAylaQbankUsageHistory(history,'incorrect'),history);
  assert.deepEqual(normalizeAylaQbankFilters({status:'Unused'}).status,'unused');
  assert.throws(()=>normalizeAylaQbankFilters({status:'fresh-ish'}),error=>error.code==='INVALID_QBANK_STATUS');
});

test('session records retain the exact multi-branch selection and usage criteria',()=>{
  const filters={selection_paths:[{system_key:'cardio',subsystem_key:'rhythm'},{system_key:'pulmonary'}],status:'marked',difficulty:'hard'};
  const session=createAylaQbankSession({id:'session',userId:'user',studentId:'student',examTrack:'usmle-step-1',
    questions:[{ref:'one',contentQuestionId:id}],filters});
  assert.deepEqual(session.filters.selection_paths,filters.selection_paths);
  assert.equal(session.filters.status,'marked');
  assert.equal(session.filters.difficulty,'hard');
});

test('compact tree uses stable exam-scoped IDs, friendly supplied labels and disjoint counts',()=>{
  const rows=[base,{...base,subtopic_key:'anticoag',subtopic_label:'Anticoagulation',question_count:8}];
  const tree=buildAylaQbankFacetTree(rows,{examTrack:'usmle-step-1'});
  const system=tree.nodes[0], subsystem=system.children[0], topic=subsystem.children[0];
  assert.equal(tree.question_count,20);
  assert.equal(system.question_count,20);
  assert.equal(topic.question_count,20);
  assert.equal(topic.children.length,2);
  assert.equal(topic.children[0].parent_id,topic.id);
  assert.deepEqual(topic.children.find(node=>node.label==='Rate control').selection_path,{system_key:'cardio',subsystem_key:'rhythm',topic_key:'af',subtopic_key:'rate'});
  assert.deepEqual(tree.coverage,{reviewed_question_count:20,source_grouped_question_count:0,unmapped_question_count:0,deeper_mapping_needed_question_count:0});
  assert.equal(buildAylaQbankFacetTree([...rows].reverse(),{examTrack:'usmle-step-1'}).taxonomy_version,tree.taxonomy_version);
  assert.equal(buildAylaQbankFacetTree([{...base,question_count:19}],{examTrack:'usmle-step-1'}).nodes[0].id,system.id);
  assert.notEqual(buildAylaQbankFacetTree(rows,{examTrack:'mccqe'}).nodes[0].id,system.id);
});

test('source-only categories remain honest selectable parent leaves with explicit coverage',()=>{
  const tree=buildAylaQbankFacetTree([{...base,topic_key:'',topic_label:'',subtopic_key:'',subtopic_label:'',mapping_status:'source_grouping',question_count:30}]);
  const subsystem=tree.nodes[0].children[0];
  assert.equal(subsystem.children.length,0);
  assert.equal(subsystem.mapping_status,'source_grouping');
  assert.equal(subsystem.unmapped_question_count,30);
  assert.deepEqual(subsystem.selection_path,{system_key:'cardio',subsystem_key:'rhythm'});
});

test('mixed reviewed/source-only branches never expose child lists that silently exclude a remainder',()=>{
  const tree=buildAylaQbankFacetTree([base,{...base,topic_key:'',subtopic_key:'',question_count:3,mapping_status:'source_grouping'}]);
  assert.equal(tree.question_count,15);
  const subsystem=tree.nodes[0].children[0];
  assert.equal(subsystem.question_count,15);
  assert.equal(subsystem.children.length,0);
  assert.equal(subsystem.children_incomplete,true);
  assert.equal(subsystem.unmapped_question_count,3);
});

test('query construction binds untrusted branch values and positions usage arrays independently of legacy scalars',()=>{
  const malicious="cardio' OR TRUE --";
  const query=contentQbankSelectionPredicate({filters:{selection_paths:[{system_key:malicious}],status:'unused',difficulty:'easy'},history,startIndex:6});
  assert.equal(query.sql.includes(malicious),false);
  assert.equal(JSON.parse(query.values[5])[0].system_key,malicious);
  assert.equal(query.values[4],'easy');
  assert.equal(query.values[6],'unused');
  assert.deepEqual(query.values[7],[id]);
  assert.match(query.sql,/jsonb_array_elements\(\$11::jsonb\)/);
  assert.match(query.sql,/NOT q.id=ANY\(\$13::uuid\[\]\)/);
  assert.match(query.sql,/>= 0\.70 THEN 'easy'/);
});

test('disjoint source exam banks merge common paths under destination IDs without changing count semantics',()=>{
  const first={...buildAylaQbankFacetTree([base],{examTrack:'mccqe'}),source_exam_track:'mccqe'};
  const second={...buildAylaQbankFacetTree([{...base,subtopic_key:'anticoag',subtopic_label:'Anticoagulation',question_count:8}],{examTrack:'usmle-step-2'}),source_exam_track:'usmle-step-2'};
  const merged=mergeAylaQbankFacets([first,second],{examTrack:'mccqe'});
  assert.equal(merged.question_count,20);
  assert.equal(merged.nodes.length,1);
  assert.equal(merged.nodes[0].question_count,20);
  assert.equal(merged.nodes[0].children[0].children[0].children.length,2);
  assert.equal(merged.nodes[0].id,first.nodes[0].id);
  assert.equal(merged.taxonomy_version,mergeAylaQbankFacets([second,first],{examTrack:'mccqe'}).taxonomy_version);
  assert.throws(()=>mergeAylaQbankFacets([first,first]),error=>error.code==='OVERLAPPING_QBANK_FACET_GROUPS');
});
