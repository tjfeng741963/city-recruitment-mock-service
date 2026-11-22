import { describe, expect, it } from 'vitest';
import { cityReceptionAccountLink, readCityReceptionContext, cityReceptionPositions, cityReceptionAccounts, cityReceptionReturnLink, readCityReceptionId, positionMatchesFactories } from '../frontend-vue/src/components/basic/city-reception.js';

describe('city reception setup', () => {
  it('opens the selected account with the chosen city and position', () => {
    const link = cityReceptionAccountLink(3, 7, 11);
    expect(link).toEqual({ path: '/agent-devices', query: { reception_city: '3', position_id: '7', account: '11' } });
    expect(readCityReceptionContext(link.query)).toEqual({ cityId: 3, positionId: 7, accountId: 11 });
  });

  it('distinguishes account creation from a malformed or missing account', () => {
    expect(readCityReceptionContext(cityReceptionAccountLink(3, 7, 'new').query)).toEqual({ cityId: 3, positionId: 7, accountId: 'new' });
    expect(readCityReceptionContext({ reception_city: '3', position_id: '7' })).toBeNull();
    expect(readCityReceptionContext({ reception_city: '3', position_id: ['7'], account: '11' })).toBeNull();
    expect(readCityReceptionContext({ reception_city: '0', position_id: '7', account: '11' })).toBeNull();
  });

  it('only offers enabled positions belonging to the city', () => {
    const positions = [
      { id: 7, position_name: '本市岗位', city_id: 3, is_active: true },
      { id: 8, position_name: '外市岗位', city_id: 4, is_active: true },
      { id: 9, position_name: '已停用岗位', city_id: 3, is_active: false },
    ];
    expect(cityReceptionPositions(positions, 3).map(position => position.id)).toEqual([7]);
  });

  it('allows an offline real account but excludes the dedicated web test device', () => {
    const offline = { id: 11, name: '招聘账号', device_code: 'REAL-01', online: false };
    expect(cityReceptionAccounts([
      offline,
      { id: 12, name: '网页测试', device_code: 'dify-sandbox-only', online: false },
      { id: 13, name: '无客户端标识', device_code: '', online: false },
      { id: 14, name: '停用账号', device_code: 'REAL-02', online: false, is_enabled: false },
    ])).toEqual([offline]);
  });

  it('preserves the chosen position when returning to the city to change accounts', () => {
    expect(cityReceptionReturnLink(3, 7)).toEqual({
      path: '/cities', query: { reception_city: '3', position_id: '7' },
    });
    expect(cityReceptionReturnLink(3)).toEqual({ path: '/cities', query: { reception_city: '3' } });
    expect(readCityReceptionId('1e2')).toBeNull();
    expect(readCityReceptionId('9007199254740992')).toBeNull();
  });

  it('keeps existing factory scope and checks whether the chosen position fits it', () => {
    expect(positionMatchesFactories({ factory_id: 4 }, [4, 5])).toBe(true);
    expect(positionMatchesFactories({ factory_id: 4 }, [5])).toBe(false);
    expect(positionMatchesFactories({ factory_id: null }, [5])).toBe(true);
    expect(positionMatchesFactories({ factory_id: 4 }, [])).toBe(true);
  });
});
