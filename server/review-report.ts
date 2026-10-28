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
export function reviewReportErrors(value: any): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['report'];
  const errors: string[] = [];
  for (const key of ['aes', 'ease', 'play']) {
    // Some compatible APIs serialize integers as strings; this is lossless.
    if (typeof value[key] === 'string' && /^[123]$/.test(value[key].trim())) value[key] = Number(value[key]);
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 3) errors.push(key);
    if (typeof value.score_reasons?.[key] !== 'string' || !value.score_reasons[key].trim()) errors.push(`score_reasons.${key}`);
  }
  if (!Array.isArray(value.uncertainties) || value.uncertainties.some((item: unknown) => typeof item !== 'string')) errors.push('uncertainties');
  for (const key of ['verdict', 'reviewer_comment', 'fix_prompt']) {
    if (typeof value[key] !== 'string') errors.push(key);
  }
  if (!Array.isArray(value.strengths) || value.strengths.some((item: unknown) => typeof item !== 'string')) errors.push('strengths');
  if (!Array.isArray(value.issues)) errors.push('issues');
  else value.issues.forEach((issue: any, index: number) => {
    for (const key of ['severity', 'area', 'problem', 'evidence', 'fix']) {
      if (typeof issue?.[key] !== 'string') errors.push(`issues[${index}].${key}`);
    }
  });
  return errors.slice(0, 12);
}
