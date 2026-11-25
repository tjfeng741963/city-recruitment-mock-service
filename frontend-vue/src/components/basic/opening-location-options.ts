import { validFlowCoordinates } from '../../../../src/shared/flow-location'

type LocationOption = { name: string; address: string; lng: number | ''; lat: number | '' }

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

function option(name: string, address: string, rawLng?: unknown, rawLat?: unknown): LocationOption {
  const lng = typeof rawLng === 'number' || typeof rawLng === 'string' ? Number(rawLng) : NaN
  const lat = typeof rawLat === 'number' || typeof rawLat === 'string' ? Number(rawLat) : NaN
  return validFlowCoordinates(lng, lat) ? { name, address, lng, lat } : { name, address, lng: '', lat: '' }
}

function fromAddress(name: string, address: string, coordinates: unknown): LocationOption {
  const parts = text(coordinates).split(/[,，]/)
  return parts.length === 2 ? option(name, address, parts[1], parts[0]) : option(name, address)
}

export function openingLocationOptions(position: Record<string, unknown> | null): LocationOption[] {
  if (!position) return []
  const points: unknown[] = Array.isArray(position.interview_points) ? position.interview_points : []
  const result = points.flatMap(point => {
    if (typeof point === 'string') return point.trim() ? [option(point.trim(), '')] : []
    if (!point || typeof point !== 'object') return []
    const item = point as Record<string, unknown>
    const name = text(item.name)
    return name ? [option(name, text(item.address), item.lng, item.lat)] : []
  })
  const legacyAddress = text(position.address)
  const interviewAddress = typeof position.interview_address === 'string' ? text(position.interview_address) : legacyAddress
  const workAddress = text(position.work_address)
  if (interviewAddress) {
    const coordinates = interviewAddress === legacyAddress && (!workAddress || workAddress === interviewAddress)
      ? position.coordinates : undefined
    result.push(fromAddress('默认面试地点', interviewAddress, coordinates))
  }
  const storeAddress = text(position.store_address)
  if (storeAddress) result.push(fromAddress(text(position.store_name) || '门店', storeAddress, position.store_coordinates))
  return result
}
