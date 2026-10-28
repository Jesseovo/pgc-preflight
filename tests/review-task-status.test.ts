import {describe,expect,it} from 'vitest';
import {reviewTaskStatus} from '../src/review-task-status';
describe('管理端审核状态',()=>{
  it('Agent有证据无结果时明确等待，不能声称平台模型正在运行',()=>{
    expect(reviewTaskStatus({status:'running',stage:'review',model_executor:'agent',error:'正在审核'})).toEqual({label:'等待 Agent 初评结果',detail:expect.stringContaining('原 Agent')});
    expect(reviewTaskStatus({status:'running',stage:'verify',model_executor:'agent'}).label).toBe('等待 Agent 复核结果');
    expect(reviewTaskStatus({status:'running',stage:'verify',model_executor:'platform'}).label).toBe('模型复核');
    expect(reviewTaskStatus({status:'error',stage:'review',model_executor:'agent',error:'已过期'})).toEqual({label:'未完成',detail:'已过期'});
  });
});
