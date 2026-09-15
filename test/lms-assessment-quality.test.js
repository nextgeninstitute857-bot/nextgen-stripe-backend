import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceChunks, questionIssues, generateGroundedAssessment, stripChoiceLabel, assessmentResponseFormat } from '../lib/lms-assessment-quality.js';

const quote='A fixed coronary stenosis limits flow reserve during exercise and causes reversible subendocardial ischemia.';
const source={id:'lecture1',title:'Coronary physiology',system:'Cardiology',text:quote+' Additional lecture evidence and explanations. '.repeat(15)};
const question={objective_id:'objective-1',stem:'A 61-year-old man develops substernal pressure while walking uphill after lunch. His symptoms disappear after five minutes of rest. Serial troponin measurements remain within the reference range, and exercise testing reproduces his symptoms. Which physiologic mechanism best explains the relationship between exertion and his chest discomfort?',options:['Fixed coronary stenosis limiting flow reserve','Persistent coronary thrombosis causing necrosis','Inflammation of the pericardial surfaces','Acute aortic wall disruption','Obstruction of pulmonary arterial circulation'],correct_index:0,explanation:'The fixed coronary narrowing prevents sufficient augmentation of blood flow when myocardial oxygen demand rises during exercise. Rest lowers demand and restores the balance between oxygen supply and consumption. The reversible symptoms and absence of biochemical evidence of injury support ischemia without myocardial necrosis, particularly in the vulnerable subendocardium.',wrong_choice_explanations:Array.from({length:5},(_,i)=>`Choice ${i} requires a different mechanism and clinical findings not present in this specific patient scenario.`),tested_concept:'Coronary flow reserve',topic:'Ischemia',difficulty:'medium',cognitive_level:'application',source_lecture_id:'lecture1',source_quote:quote};

test('every source tail is processed, no silent 60k cutoff',()=>{
  const text='x'.repeat(70000)+'unique final tail';
  const chunks=sourceChunks([{...source,text}]);
  assert.equal(chunks.length,8);assert.ok(chunks.at(-1).text.endsWith('unique final tail'));
  assert.throws(()=>sourceChunks([{...source,text:'short'}]),/too short/);
});
test('strict schema is used for every generation and review stage',()=>{
  for(const stage of ['blueprint','write','review','explanation_review']) {
    const format=assessmentResponseFormat(stage);assert.equal(format.type,'json_schema');assert.equal(format.strict,true);assert.equal(format.schema.additionalProperties,false);
  }
});
test('structural gates reject duplicate choices, unsupported sources and filler',()=>{
  const map=new Map([[source.id,source]]);
  assert.deepEqual(questionIssues(question,map),[]);
  assert.ok(questionIssues({...question,options:['A','A','B','C','D']},map).some(x=>x.includes('Duplicate')));
  assert.ok(questionIssues({...question,source_lecture_id:'outside'},map).some(x=>x.includes('outside')));
  assert.ok(questionIssues({...question,source_quote:'made-up supporting lecture quotation here'},map).some(x=>x.includes('supporting')));
  assert.ok(questionIssues({...question,explanation:'Match the dominant clue in the stem'},map).length);
  assert.equal(stripChoiceLabel('D: This explanation follows the option.'),'This explanation follows the option.');
});
function fakeAsk({reject=false}={}) {
  const stages=[];
  const ask=async request=>{
    stages.push(request.stage);
    if(request.stage==='blueprint')return {objectives:[{concept:'Coronary flow reserve',evidence_quote:quote}],source_concerns:[]};
    if(request.stage==='write')return {questions:[structuredClone(question)]};
    if(request.stage==='review') {
      assert.ok(!request.userPrompt.includes('"correct_index":'));
      return {reviews:[{objective_id:'objective-1',independent_correct_index:reject?2:0,approved:!reject,clinical_accuracy:true,source_supported:true,plausible_distractors:true,reasoning_required:true,rationale:'The clinical history and source mechanism together support the independently selected answer here.'}]};
    }
    return {reviews:[{objective_id:'objective-1',approved:true,rationale:'Explanations match the medical mechanism and choice order.'}]};
  };
  return {ask,stages};
}
test('production pipeline requires blind answer and explanation reviews before acceptance',async()=>{
  const ai=fakeAsk();const result=await generateGroundedAssessment({sources:[source],questionCount:1,ask:ai.ask});
  assert.deepEqual(ai.stages,['blueprint','write','review','explanation_review']);
  assert.equal(result.quality_report.human_review_required,true);
  assert.equal(result.quality_report.coverage[0].questions,1);
  assert.equal(result.questions[0].source_lecture_id,source.id);
});
test('answer disagreement fails closed after one bounded repair',async()=>{
  const ai=fakeAsk({reject:true});
  await assert.rejects(generateGroundedAssessment({sources:[source],questionCount:1,ask:ai.ask}),/Quality review held/);
  assert.equal(ai.stages.filter(s=>s==='write').length,2);
});
test('insufficient objectives cannot be filled with unrelated material',async()=>{
  const ai=fakeAsk();
  await assert.rejects(generateGroundedAssessment({sources:[source],questionCount:40,ask:ai.ask}),/Only 1 distinct supported objectives/);
  assert.deepEqual(ai.stages,['blueprint']);
});
test('fabricated blueprint evidence fails before writing questions',async()=>{
  await assert.rejects(generateGroundedAssessment({sources:[source],questionCount:1,ask:async()=>({objectives:[{concept:'other',evidence_quote:'An invented sentence with no grounding in the selected lecture.'}],source_concerns:[]})}),/Unverifiable/);
});
