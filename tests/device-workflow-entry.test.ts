import { describe, expect, it } from 'vitest';
import { deviceWorkflowEntry, isWebTestDevice, deviceOnline, workflowPositionSelection } from '../frontend-vue/src/components/agent/device-workflow-entry.js';

describe('account workflow navigation', () => {
  it('never falls back to another position for an explicit invalid or deleted position', () => {
    expect(workflowPositionSelection('25', 1, [1,2])).toEqual({id:0,error:'指定岗位不存在或无权访问，请返回账号接待设置重新选择'});
    expect(workflowPositionSelection('bad', 1, [1,2]).id).toBe(0);
    expect(workflowPositionSelection('2', 1, [1,2])).toEqual({id:2,error:''});
    expect(workflowPositionSelection(undefined, 2, [1,2])).toEqual({id:2,error:''});
    expect(workflowPositionSelection(undefined, 9, [1,2])).toEqual({id:1,error:''});
  });
  it('opens the bound Agent position, never the last visited position', () => {
    expect(deviceWorkflowEntry({device_code:'pc-win-01',reply_provider:'agent',position_id:25}))
      .toEqual({href:'/recruitment-flow?position_id=25',label:'工作流配置',reason:''});
    expect(deviceWorkflowEntry({device_code:'new',reply_provider:'agent',position_id:0}).href).toBeNull();
    expect(deviceWorkflowEntry({device_code:'new',reply_provider:'agent',position_id:-3}).href).toBeNull();
  });
  it('opens Dify with the exact device even when there is no Agent position', () => {
    expect(deviceWorkflowEntry({device_code:'test /中文',reply_provider:'dify'}).href)
      .toBe('/dify-connection?device_code=test%20%2F%E4%B8%AD%E6%96%87');
  });
  it('does not guess a provider when list data is missing or invalid', () => {
    expect(deviceWorkflowEntry({device_code:'pc',position_id:25}).href).toBeNull();
    expect(deviceWorkflowEntry({device_code:'pc',reply_provider:'other',position_id:25}).href).toBeNull();
    expect(deviceWorkflowEntry({device_code:'',reply_provider:'dify'}).href).toBeNull();
  });
  it('separates the existing web sandbox and treats online strictly as connection evidence', () => {
    expect(isWebTestDevice({device_code:'dify-sandbox-only'})).toBe(true);
    expect(isWebTestDevice({device_code:'pc-win-01',reply_provider:'dify'})).toBe(false);
    expect(deviceOnline({online:false,status:true})).toBe(false);
    expect(deviceOnline({status:'enabled'})).toBe(false);
    expect(deviceOnline({online:true})).toBe(true);
  });
});
