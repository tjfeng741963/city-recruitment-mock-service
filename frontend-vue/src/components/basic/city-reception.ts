import type { ServicePosition } from '../../api/types'
import { isWebTestDevice } from '../agent/device-workflow-entry'

type AccountId = number | 'new'

export function readCityReceptionId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function cityReceptionAccountLink(cityId: number, positionId: number, accountId: AccountId) {
  return {
    path: '/agent-devices',
    query: { reception_city: String(cityId), position_id: String(positionId), account: String(accountId) },
  }
}

export function cityReceptionReturnLink(cityId: number, positionId?: number) {
  return {
    path: '/cities',
    query: { reception_city: String(cityId), ...(positionId ? { position_id: String(positionId) } : {}) },
  }
}

export function readCityReceptionContext(query: Record<string, unknown>) {
  const cityId = readCityReceptionId(query.reception_city)
  const positionId = readCityReceptionId(query.position_id)
  const accountId = query.account === 'new' ? 'new' : readCityReceptionId(query.account)
  return cityId && positionId && accountId ? { cityId, positionId, accountId } : null
}

export function cityReceptionPositions<T extends Pick<ServicePosition, 'city_id' | 'is_active'>>(
  positions: T[], cityId: number,
): T[] {
  return positions.filter(position => position.city_id === cityId && position.is_active === true)
}

export function cityReceptionAccounts<T extends { device_code?: string; is_enabled?: boolean }>(accounts: T[]): T[] {
  return accounts.filter(account => account.device_code && account.is_enabled !== false && !isWebTestDevice(account))
}

export function positionMatchesFactories(position: Pick<ServicePosition, 'factory_id'>, factoryIds: number[]): boolean {
  const factoryId = Number(position.factory_id)
  return factoryIds.length === 0 || !factoryId || factoryIds.includes(factoryId)
}
