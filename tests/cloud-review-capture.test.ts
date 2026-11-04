import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {captureFor} from '../server/cloud-review-capture';
import {acquireBrowser} from '../server/browser-capacity';
import {captureReview} from '../server/review-probe';
import {recordReviewTiming} from '../server/review-timing';
vi.mock('../server/browser-capacity',()=>({acquireBrowser:vi.fn(),connectAcquiredBrowser:vi.fn()}));
vi.mock('../server/review-probe',()=>({captureReview:vi.fn()}));
vi.mock('../server/review-timing',()=>({recordReviewTiming:vi.fn()}));
beforeEach(()=>{vi.mocked(recordReviewTiming).mockResolvedValue(true);});
afterEach(()=>{vi.resetAllMocks();});
describe('cloud capture lifecycle and browser timing',()=>{
 it('records browser acquisition separately and passes unchanged HTML to the existing capture pipeline',async()=>{
  const browser={close:vi.fn(async()=>{})},evidence={shots:[1,2,3,4],probe:{captureMethod:'browser-viewport-v1'}};
  vi.mocked(acquireBrowser).mockResolvedValue(browser);vi.mocked(captureReview).mockResolvedValue(evidence as any);
  const env={DB:{},reviewJobId:'synthetic-job'};await expect(captureFor(env)('<html>synthetic</html>')).resolves.toEqual(evidence);
  expect(captureReview).toHaveBeenCalledWith(browser,'<html>synthetic</html>');expect(browser.close).toHaveBeenCalledOnce();expect(recordReviewTiming).toHaveBeenCalledWith(env.DB,expect.objectContaining({jobId:'synthetic-job',phase:'browser_start',origin:'server',status:'ok'}));
 });
 it('telemetry failure does not block capture and a capture error still closes the acquired browser',async()=>{
  const browser={close:vi.fn(async()=>{})};vi.mocked(acquireBrowser).mockResolvedValue(browser);vi.mocked(recordReviewTiming).mockRejectedValueOnce(new Error('synthetic telemetry error'));vi.mocked(captureReview).mockRejectedValueOnce(new Error('synthetic capture error'));
  await expect(captureFor({DB:{},reviewJobId:'synthetic-job'})('synthetic')).rejects.toThrow('synthetic capture error');expect(browser.close).toHaveBeenCalledOnce();
 });
 it('failed browser acquisition is measured as an error and cannot reach capture or a model',async()=>{
  vi.mocked(acquireBrowser).mockRejectedValueOnce(new Error('synthetic acquisition error'));
  await expect(captureFor({DB:{},reviewJobId:'synthetic-job'})('synthetic')).rejects.toThrow('synthetic acquisition error');expect(captureReview).not.toHaveBeenCalled();expect(recordReviewTiming).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({phase:'browser_start',status:'error'}));
 });
});
