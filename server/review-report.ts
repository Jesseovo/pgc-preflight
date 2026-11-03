// Validate the model's report without supplying scores or review conclusions.
export function normalizeReviewOutput(value:any){
  // Some JSON-mode responses wrap an otherwise complete report. Removing a
  // single known envelope preserves every score, reason and suggestion. Never
  // prefer nested scores over conflicting root fields or invent missing data.
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const keys=Object.keys(value);
    if(keys.length===1&&['report','result','data','final_report','review'].includes(keys[0])){
      const report=value[keys[0]];
      if(!reviewReportErrors(report).length)return report;
    }
  }
  return value;
}
export function reviewReportErrors(value: any, options: {schemaVersion?: 1 | 2} = {}): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['report'];
  const errors: string[] = [];
  const version = options.schemaVersion ?? (value.schema_version === 2 ? 2 : 1);
  const v2 = version === 2;
  if (value.schema_version != null && value.schema_version !== version) errors.push('schema_version');
  if (v2) {
    if (value.schema_version !== 2) errors.push('schema_version');
    if (!['complete', 'needs_review'].includes(value.assessment_status)) errors.push('assessment_status');
    const allowed = ['schema_version','assessment_status','aes','ease','play','score_reasons','uncertainties','verdict','reviewer_comment','strengths','issues','fix_prompt','optional_suggestions'];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(key);
    if (!Array.isArray(value.optional_suggestions) || value.optional_suggestions.some((item: unknown) => typeof item !== 'string')) errors.push('optional_suggestions');
    if (value.score_reasons && typeof value.score_reasons === 'object') for (const key of Object.keys(value.score_reasons)) if (!['aes','ease','play'].includes(key)) errors.push(`score_reasons.${key}`);
  }
  for (const key of ['aes', 'ease', 'play']) {
    // Some compatible APIs serialize integers as strings; this is lossless.
    if (!v2 && typeof value[key] === 'string' && /^[123]$/.test(value[key].trim())) value[key] = Number(value[key]);
    if (!(v2 && value[key] === null) && (!Number.isInteger(value[key]) || value[key] < (v2 ? 0 : 1) || value[key] > 3)) errors.push(key);
    if (typeof value.score_reasons?.[key] !== 'string' || !value.score_reasons[key].trim()) errors.push(`score_reasons.${key}`);
  }
  if (v2) {
    const unknown = ['aes','ease','play'].some(key => value[key] === null);
    if (unknown && value.assessment_status !== 'needs_review') errors.push('assessment_status');
    if (value.assessment_status === 'needs_review' && (typeof value.verdict !== 'string' || !value.verdict.startsWith('待复核'))) errors.push('verdict');
    if (unknown && (!Array.isArray(value.uncertainties) || !value.uncertainties.length)) errors.push('uncertainties');
    if (value.assessment_status === 'complete' && (typeof value.verdict !== 'string' || !/^(通过|打回)/.test(value.verdict))) errors.push('verdict');
  }
  if (!Array.isArray(value.uncertainties) || value.uncertainties.some((item: unknown) => typeof item !== 'string')) errors.push('uncertainties');
  for (const key of ['verdict', 'reviewer_comment', 'fix_prompt']) {
    if (typeof value[key] !== 'string') errors.push(key);
  }
  if (!Array.isArray(value.strengths) || value.strengths.some((item: unknown) => typeof item !== 'string')) errors.push('strengths');
  if (!Array.isArray(value.issues)) errors.push('issues');
  else value.issues.forEach((issue: any, index: number) => {
    if (v2) {
      if (!['confirmed','experience','unverified'].includes(issue?.kind)) errors.push(`issues[${index}].kind`);
      if (!Array.isArray(issue?.evidence_refs) || issue.evidence_refs.some((ref: unknown) => typeof ref !== 'string' || !ref.trim()) || (issue.kind !== 'unverified' && !issue.evidence_refs.length)) errors.push(`issues[${index}].evidence_refs`);
      for (const key of Object.keys(issue || {})) if (!['severity','area','problem','evidence','fix','kind','evidence_refs'].includes(key)) errors.push(`issues[${index}].${key}`);
    }
    for (const key of ['severity', 'area', 'problem', 'evidence', 'fix']) {
      if (typeof issue?.[key] !== 'string') errors.push(`issues[${index}].${key}`);
    }
  });
  return errors.slice(0, 12);
}

// Arithmetic only; unknown evidence is never converted to a zero score.
export function reportScore(report: any): number | null {
  if (!report || (report.schema_version === 2 && report.assessment_status !== 'complete')) return null;
  const values = ['aes','ease','play'].map(key => report[key]);
  return values.every(value => Number.isInteger(value) && value >= (report.schema_version === 2 ? 0 : 1) && value <= 3) ? values.reduce((sum, value) => sum + value, 0) : null;
}
