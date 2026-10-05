import { randomUUID } from 'node:crypto';

export type OrderStatus = 'draft' | 'confirmed' | 'allocated' | 'dispatched' | 'delivered' | 'closed' | 'cancelled';
export type CustomsStatus = 'draft' | 'submitted' | 'inspection' | 'cleared' | 'rejected';
export type InvoiceStatus = 'issued' | 'partially_paid' | 'paid' | 'void';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

type Tenant = { id: string; name: string; creditLimit: number; creditUsed: number; currency: string };
type Customer = { id: string; tenantId: string; name: string; creditLimit: number; creditUsed: number; blocked: boolean; timezone?: string };
type OrderItem = { sku: string; description: string; quantity: number; unitPrice: number; weightKg: number; hsCode: string };
export type Order = { id: string; tenantId: string; customerId: string; reference: string; origin: string; destination: string; priority: 'standard' | 'urgent' | 'critical'; status: OrderStatus; items: OrderItem[]; totalWeightKg: number; subtotal: number; totalAmount: number; currency: string; version: number; shipmentId?: string; customsDeclarationId?: string; invoiceId?: string; createdAt: string; updatedAt: string };
type InventoryLot = { id: string; tenantId: string; warehouse: string; sku: string; available: number; reserved: number; lotCode: string; expiresAt?: string };
type Reservation = { id: string; tenantId: string; orderId: string; lotId: string; sku: string; quantity: number; status: 'active' | 'released' | 'consumed'; createdAt: string };
type ShipmentLeg = { id: string; mode: 'truck' | 'rail' | 'sea' | 'air'; origin: string; destination: string; plannedDeparture: string; plannedArrival: string; actualArrival?: string; status: 'planned' | 'in_transit' | 'arrived' | 'delayed' };
type Shipment = { id: string; tenantId: string; orderId: string; trackingNo: string; legs: ShipmentLeg[]; currentLocation: string; eta: string; status: 'planned' | 'in_transit' | 'delivered' | 'exception'; events: { id: string; eventId?: string; code: string; location: string; occurredAt: string; note?: string }[] };
type CustomsDeclaration = { id: string; tenantId: string; orderId: string; country: string; status: CustomsStatus; documentRefs: string[]; requiredDocuments: string[]; riskScore: number; rejectionReason?: string; updatedAt: string };
type InvoiceLine = { code: string; description: string; quantity: number; unitPrice: number; amount: number };
type Invoice = { id: string; tenantId: string; orderId: string; number: string; status: InvoiceStatus; currency: string; lines: InvoiceLine[]; subtotal: number; tax: number; total: number; paid: number; dueDate: string; createdAt: string };
type Payment = { id: string; tenantId: string; invoiceId: string; amount: number; method: 'bank_transfer' | 'card' | 'credit_note'; reference: string; receivedAt: string };
type Approval = { id: string; tenantId: string; orderId: string; type: 'credit_override' | 'customs_exception' | 'delay_compensation'; reason: string; status: ApprovalStatus; decidedBy?: string; comment?: string; createdAt: string; decidedAt?: string };
export type AuditEvent = { id: string; tenantId: string; actor: string; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; at: string };
export type OutboxEvent = { id: string; tenantId: string; topic: string; aggregateId: string; payload: unknown; status: 'pending' | 'published'; attempts: number; createdAt: string };

type State = { tenants: Tenant[]; customers: Customer[]; orders: Order[]; inventory: InventoryLot[]; reservations: Reservation[]; shipments: Shipment[]; customs: CustomsDeclaration[]; invoices: Invoice[]; payments: Payment[]; approvals: Approval[]; audit: AuditEvent[]; outbox: OutboxEvent[]; eventInbox: ProcessedOrderEvent[] };
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const money = (value: number) => Math.round(value * 100) / 100;

export const state: State = {
  tenants: [{ id: 'tenant-acme', name: 'Acme Global Trading', creditLimit: 250000, creditUsed: 36200, currency: 'USD' }],
  customers: [{ id: 'CUS-001', tenantId: 'tenant-acme', name: 'Northstar Retail GmbH', creditLimit: 100000, creditUsed: 12000, blocked: false, timezone: 'Europe/Berlin' }, { id: 'CUS-002', tenantId: 'tenant-acme', name: 'Pacific Parts Inc.', creditLimit: 50000, creditUsed: 49000, blocked: false, timezone: 'America/Los_Angeles' }],
  orders: [], inventory: [
    { id: 'LOT-001', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'SENSOR-X9', available: 80, reserved: 10, lotCode: 'SX9-2608' },
    { id: 'LOT-002', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'CONTROL-M2', available: 36, reserved: 4, lotCode: 'CM2-2607' },
    { id: 'LOT-003', tenantId: 'tenant-acme', warehouse: 'ROTTERDAM-DC', sku: 'SENSOR-X9', available: 12, reserved: 0, lotCode: 'SX9-2606' }
  ], reservations: [], shipments: [], customs: [], invoices: [], payments: [], approvals: [], audit: [], outbox: [], eventInbox: []
};

function tenant(id: string) { const value = state.tenants.find(item => item.id === id); if (!value) throw new Error('租户不存在'); return value; }
function assertTenant<T extends { tenantId: string }>(item: T, tenantId: string) { if (item.tenantId !== tenantId) throw new Error('无权访问其他租户的数据'); return item; }
function customerFor(tenantId: string, customerId: string) { const customer = state.customers.find(item => item.id === customerId && item.tenantId === tenantId); if (!customer) throw new Error('客户不存在'); return customer; }
function orderFor(tenantId: string, orderId: string) { const order = state.orders.find(item => item.id === orderId); if (!order) throw new Error('订单不存在'); return assertTenant(order, tenantId); }
function record(tenantId: string, actor: string, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) { state.audit.unshift({ id: id('AUD'), tenantId, actor, action, entityType, entityId, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after), at: now() }); }
function emit(tenantId: string, topic: string, aggregateId: string, payload: unknown) { state.outbox.unshift({ id: id('EVT'), tenantId, topic, aggregateId, payload: clone(payload), status: 'pending', attempts: 0, createdAt: now() }); }
function mutate(tenantId: string, actor: string, action: string, type: string, entityId: string, before: unknown, after: unknown, topic: string) { record(tenantId, actor, action, type, entityId, before, after); if (action !== 'order.confirmed') emit(tenantId, topic, entityId, after); }
// 业务状态边界：只允许单调前进，delivered/closed/cancelled 为终态（delivered 仅可前进到 closed），任何迟到事件不得使其倒退。
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = { draft: ['confirmed', 'cancelled'], confirmed: ['allocated', 'cancelled'], allocated: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['closed'], closed: [], cancelled: [] };
const STATUS_RANK: Record<OrderStatus, number> = { draft: 0, confirmed: 1, allocated: 2, dispatched: 3, delivered: 4, closed: 5, cancelled: 6 };
function transition(order: Order, next: OrderStatus) { if (!ALLOWED_TRANSITIONS[order.status].includes(next)) throw new Error(`订单不能从 ${order.status} 变更为 ${next}`); order.status = next; order.version += 1; order.updatedAt = now(); }

export function listOrders(tenantId: string, filters: { status?: string; customerId?: string; q?: string } = {}) { tenant(tenantId); return state.orders.filter(item => item.tenantId === tenantId && (!filters.status || item.status === filters.status) && (!filters.customerId || item.customerId === filters.customerId) && (!filters.q || `${item.reference} ${item.destination}`.toLowerCase().includes(filters.q.toLowerCase()))).map(clone); }
export function getOrder(tenantId: string, orderId: string) { return clone(orderFor(tenantId, orderId)); }
export function createOrder(tenantId: string, input: Partial<Order>, actor = 'system') {
  tenant(tenantId); if (!input.customerId || !input.reference || !input.origin || !input.destination || !input.items?.length) throw new Error('客户、参考号、起讫地和订单明细均不能为空');
  if (state.orders.some(item => item.reference === input.reference)) throw new Error('客户参考号已存在');
  const items = input.items.map(item => { if (!item.sku || !item.quantity || item.quantity <= 0 || !item.unitPrice || item.unitPrice < 0 || !item.weightKg || item.weightKg <= 0) throw new Error('订单明细数量、价格和重量必须为正数'); return { sku: item.sku, description: item.description ?? item.sku, quantity: item.quantity, unitPrice: item.unitPrice, weightKg: item.weightKg, hsCode: item.hsCode ?? '0000.00' }; });
  const subtotal = money(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)); const order: Order = { id: id('ORD'), tenantId, customerId: input.customerId, reference: input.reference, origin: input.origin, destination: input.destination, priority: input.priority ?? 'standard', status: 'draft', items, totalWeightKg: money(items.reduce((sum, item) => sum + item.quantity * item.weightKg, 0)), subtotal, totalAmount: subtotal, currency: input.currency ?? tenant(tenantId).currency, version: 1, createdAt: now(), updatedAt: now() };
  state.orders.unshift(order); mutate(tenantId, actor, 'order.created', 'order', order.id, undefined, order, 'order.created'); return clone(order);
}
export function confirmOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); const customer = customerFor(tenantId, order.customerId); if (customer.blocked) throw new Error('客户已被风控冻结'); if (customer.creditUsed + order.totalAmount > customer.creditLimit) { const approval = createApproval(tenantId, { orderId, type: 'credit_override', reason: '订单金额超过客户授信额度' }, actor); throw new Error(`客户授信不足，需要审批 ${approval.id}`); } transition(order, 'confirmed'); customer.creditUsed = money(customer.creditUsed + order.totalAmount); mutate(tenantId, actor, 'order.confirmed', 'order', order.id, before, order, 'order.confirmed'); return clone(order); }
export function allocateOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); const allocations: Reservation[] = []; for (const item of order.items) { let remaining = item.quantity; for (const lot of state.inventory.filter(value => value.tenantId === tenantId && value.sku === item.sku && value.available - value.reserved > 0)) { const qty = Math.min(remaining, lot.available); lot.reserved += qty; remaining -= qty; allocations.push({ id: id('RSV'), tenantId, orderId, lotId: lot.id, sku: item.sku, quantity: qty, status: 'active', createdAt: now() }); if (!remaining) break; } if (remaining) { for (const allocation of allocations) { const lot = state.inventory.find(value => value.id === allocation.lotId)!; lot.reserved -= allocation.quantity; } throw new Error(`库存不足：${item.sku} 还缺少 ${remaining}`); } } state.reservations.push(...allocations); transition(order, 'allocated'); mutate(tenantId, actor, 'order.allocated', 'order', order.id, before, { order, allocations }, 'inventory.reserved'); return clone(order); }
export function dispatchOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const customs = state.customs.find(item => item.orderId === orderId); if (!customs || customs.status !== 'cleared') throw new Error('海关申报尚未放行'); const reservations = state.reservations.filter(item => item.orderId === orderId && item.status === 'active'); if (!reservations.length) throw new Error('订单没有有效库存分配'); const before = clone(order); transition(order, 'dispatched'); reservations.forEach(reservation => { const lot = state.inventory.find(item => item.id === reservation.lotId)!; lot.available -= reservation.quantity; lot.reserved -= reservation.quantity; reservation.status = 'consumed'; }); const shipment: Shipment = { id: id('SHP'), tenantId, orderId, trackingNo: `CBF${Date.now().toString().slice(-8)}`, legs: [{ id: id('LEG'), mode: 'truck', origin: order.origin, destination: '出口口岸', plannedDeparture: now(), plannedArrival: new Date(Date.now() + 86400000).toISOString(), status: 'planned' }, { id: id('LEG'), mode: 'sea', origin: '出口口岸', destination: order.destination, plannedDeparture: new Date(Date.now() + 172800000).toISOString(), plannedArrival: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned' }], currentLocation: order.origin, eta: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned', events: [] }; state.shipments.push(shipment); order.shipmentId = shipment.id; mutate(tenantId, actor, 'order.dispatched', 'order', order.id, before, { order, shipment }, 'shipment.created'); return clone(order); }
export function deliverOrder(tenantId: string, orderId: string, actor = 'system', options: { occurredAt?: string } = {}) { const order = orderFor(tenantId, orderId); const shipment = state.shipments.find(item => item.orderId === orderId); if (!shipment) throw new Error('运输单不存在'); const before = clone(order); transition(order, 'delivered'); shipment.status = 'delivered'; shipment.currentLocation = order.destination; shipment.events.push({ id: id('TRK'), code: 'DELIVERED', location: order.destination, occurredAt: options.occurredAt ?? now(), note: '签收完成' }); shipment.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)); mutate(tenantId, actor, 'order.delivered', 'order', order.id, before, { order, shipment }, 'shipment.delivered'); return clone(order); }
export function closeOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const invoice = state.invoices.find(item => item.orderId === orderId); if (!invoice || invoice.status !== 'paid') throw new Error('发票未完成收款核销'); const before = clone(order); transition(order, 'closed'); const customer = customerFor(tenantId, order.customerId); customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.closed', 'order', order.id, before, order, 'order.closed'); return clone(order); }
export function cancelOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); if (['dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('已出运订单不能取消'); transition(order, 'cancelled'); const reservation = state.reservations.find(item => item.orderId === orderId && item.status === 'active'); if (reservation) { state.inventory.find(lot => lot.id === reservation.lotId)!.reserved -= reservation.quantity; reservation.status = 'released'; } const customer = customerFor(tenantId, order.customerId); if (before.status !== 'draft') customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.cancelled', 'order', order.id, before, order, 'order.cancelled'); return clone(order); }

// ---- 运输链路事件摄入：按事件时间、接收时间和业务状态界定迁移边界 ----
export type OrderEventType = 'confirmed' | 'allocated' | 'dispatched' | 'delivered' | 'closed' | 'cancelled' | 'exception';
export type IngestOutcome = 'applied' | 'duplicate' | 'superseded' | 'rejected';
export type OrderEventInput = { eventId: string; orderId?: string; reference?: string; type: OrderEventType; occurredAt: string; source?: string; location?: string; note?: string };
export type ProcessedOrderEvent = { eventId: string; tenantId: string; orderId: string; type: OrderEventType; occurredAt: string; receivedAt: string; outcome: IngestOutcome; reason: string };
export type EventConflict = { currentStatus: OrderStatus; winningEventId?: string; winningEventType?: OrderEventType; winningAt?: string };
export type IngestResult = { eventId: string; orderId: string; outcome: IngestOutcome; orderStatus: OrderStatus; reason: string; conflict?: EventConflict; order?: Order };

const ORDER_EVENT_TYPES: OrderEventType[] = ['confirmed', 'allocated', 'dispatched', 'delivered', 'closed', 'cancelled', 'exception'];
const TRACKING_CODE: Partial<Record<OrderEventType, string>> = { dispatched: 'DEPARTED', delivered: 'DELIVERED', exception: 'EXCEPTION' };

function conflictInfo(order: Order): EventConflict {
  const winning = [...state.eventInbox].reverse().find(item => item.orderId === order.id && item.outcome === 'applied');
  return { currentStatus: order.status, winningEventId: winning?.eventId, winningEventType: winning?.type, winningAt: winning?.receivedAt ?? order.updatedAt };
}

// 迟到/冲突的运输类事件仍保留原始轨迹（按事件时间插入），但不触碰运单当前位置与状态，也不发 outbox。
function appendRawTrajectory(order: Order, code: string, input: OrderEventInput, tag: string) {
  const shipment = state.shipments.find(item => item.orderId === order.id);
  if (!shipment) return;
  const location = input.location ?? shipment.currentLocation;
  if (shipment.events.some(item => item.code === code && item.location === location && item.occurredAt === input.occurredAt)) return;
  shipment.events.push({ id: id('TRK'), eventId: input.eventId, code, location, occurredAt: input.occurredAt, note: `[${tag}] ${input.note ?? '迟到/冲突事件，仅保留原始轨迹'}`.trim() });
  shipment.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

export function ingestOrderEvent(tenantId: string, input: OrderEventInput, actor = 'event-ingest'): IngestResult {
  tenant(tenantId);
  if (!input.eventId?.trim()) throw new Error('事件必须携带 eventId 用于幂等去重');
  if (!ORDER_EVENT_TYPES.includes(input.type)) throw new Error(`未知事件类型 ${input.type}`);
  if (!input.occurredAt || Number.isNaN(Date.parse(input.occurredAt))) throw new Error('事件时间 occurredAt 不合法');
  const receivedAt = now();

  // 接收时间边界：同一 eventId 只处理一次，重放返回首次处理结果，不产生二次业务效果。
  const seen = state.eventInbox.find(item => item.tenantId === tenantId && item.eventId === input.eventId);
  if (seen) {
    if ((input.orderId && input.orderId !== seen.orderId) || input.type !== seen.type) throw new Error(`事件 ${input.eventId} 与已处理事件的订单或类型不一致`);
    const order = state.orders.find(item => item.id === seen.orderId);
    return { eventId: seen.eventId, orderId: seen.orderId, outcome: 'duplicate', orderStatus: order?.status ?? 'draft', reason: `重复上传：事件已于 ${seen.receivedAt} 处理为 ${seen.outcome}，不再产生业务效果`, order: order ? clone(order) : undefined };
  }
  const order = (input.orderId ? orderFor(tenantId, input.orderId) : state.orders.find(item => item.tenantId === tenantId && item.reference === input.reference)) ?? (() => { throw new Error('订单不存在'); })();

  const finish = (outcome: IngestOutcome, reason: string, conflict?: EventConflict): IngestResult => {
    state.eventInbox.push({ eventId: input.eventId, tenantId, orderId: order.id, type: input.type, occurredAt: input.occurredAt, receivedAt, outcome, reason });
    if (outcome !== 'applied') record(tenantId, actor, `order.event.${outcome}`, 'order', order.id, undefined, { event: { eventId: input.eventId, type: input.type, occurredAt: input.occurredAt, receivedAt, source: input.source ?? 'unknown' }, reason, conflict });
    return { eventId: input.eventId, orderId: order.id, outcome, orderStatus: order.status, reason, conflict, order: clone(order) };
  };

  // 异常签收：只影响运输轨迹与审计，不改变订单状态机。
  if (input.type === 'exception') {
    const shipment = state.shipments.find(item => item.orderId === order.id);
    if (!shipment) return finish('rejected', '异常签收事件没有对应运输单，已拒绝', conflictInfo(order));
    const result = applyShipmentEvent(tenantId, shipment, { code: 'EXCEPTION', location: input.location ?? order.destination, occurredAt: input.occurredAt, note: input.note, eventId: input.eventId }, actor);
    return finish(result.outcome, `异常签收：${result.reason}`, result.outcome === 'applied' ? undefined : conflictInfo(order));
  }

  const target = input.type as OrderStatus;
  const current = order.status;
  if (current === target) return finish('duplicate', `订单已处于 ${current}，重复的 ${input.type} 事件只记录审计，不产生二次业务效果`, conflictInfo(order));

  if (!ALLOWED_TRANSITIONS[current].includes(target)) {
    const conflict = conflictInfo(order);
    const won = conflict.winningEventId ? `（当前状态由事件 ${conflict.winningEventId} 于 ${conflict.winningAt} 确定）` : `（当前状态于 ${conflict.winningAt} 确定）`;
    if (current === 'cancelled') return finish('rejected', `冲突：订单已取消（终态）${won}，${input.type} 事件被拒绝`, conflict);
    if (target === 'cancelled') return finish('rejected', `冲突：订单已 ${current}${won}，取消请求被拒绝`, conflict);
    if (STATUS_RANK[target] < STATUS_RANK[current]) {
      const code = TRACKING_CODE[input.type];
      if (code) appendRawTrajectory(order, code, input, 'superseded');
      return finish('superseded', `迟到事件：${input.type} 发生于 ${input.occurredAt}、于 ${receivedAt} 到达，但订单已处于 ${current}${won}；终态不倒退，仅保留审计与原始轨迹`, conflict);
    }
    return finish('rejected', `非法迁移：订单不能从 ${current} 直接变更为 ${target}${won}`, conflict);
  }

  try {
    if (target === 'confirmed') confirmOrder(tenantId, order.id, actor);
    else if (target === 'allocated') allocateOrder(tenantId, order.id, actor);
    else if (target === 'dispatched') dispatchOrder(tenantId, order.id, actor);
    else if (target === 'delivered') deliverOrder(tenantId, order.id, actor, { occurredAt: input.occurredAt });
    else if (target === 'closed') closeOrder(tenantId, order.id, actor);
    else if (target === 'cancelled') cancelOrder(tenantId, order.id, actor);
    return finish('applied', `事件已应用：订单 ${current} → ${target}（事件时间 ${input.occurredAt}，接收时间 ${receivedAt}）`);
  } catch (error) {
    return finish('rejected', `事件前置条件不满足：${error instanceof Error ? error.message : String(error)}`, conflictInfo(order));
  }
}

export function listOrderEvents(tenantId: string, orderId?: string) { tenant(tenantId); return state.eventInbox.filter(item => item.tenantId === tenantId && (!orderId || item.orderId === orderId)).map(clone); }

export function createCustomsDeclaration(tenantId: string, input: { orderId: string; country?: string; requiredDocuments?: string[] }, actor = 'system') { const order = orderFor(tenantId, input.orderId); if (state.customs.some(item => item.orderId === order.id)) throw new Error('订单已有海关申报'); const declaration: CustomsDeclaration = { id: id('CUS'), tenantId, orderId: order.id, country: input.country ?? order.destination, status: 'draft', documentRefs: [], requiredDocuments: input.requiredDocuments ?? ['commercial-invoice', 'packing-list', 'origin-certificate'], riskScore: order.priority === 'critical' ? 82 : order.totalWeightKg > 1000 ? 60 : 24, updatedAt: now() }; state.customs.push(declaration); order.customsDeclarationId = declaration.id; mutate(tenantId, actor, 'customs.created', 'customs', declaration.id, undefined, declaration, 'customs.created'); return clone(declaration); }
export function updateCustoms(tenantId: string, declarationId: string, input: { status?: CustomsStatus; documentRefs?: string[]; rejectionReason?: string }, actor = 'system') { const declaration = assertTenant(state.customs.find(item => item.id === declarationId) ?? (() => { throw new Error('海关申报不存在'); })(), tenantId); const before = clone(declaration); if (input.documentRefs) declaration.documentRefs = [...new Set(input.documentRefs)]; if (input.status) { if (input.status === 'cleared' && declaration.requiredDocuments.some(doc => !declaration.documentRefs.includes(doc))) throw new Error('放行前必须补齐所有必需单证'); if (input.status === 'inspection' && declaration.status !== 'submitted') throw new Error('只有已提交申报才能进入查验'); declaration.status = input.status; } declaration.rejectionReason = input.rejectionReason; declaration.updatedAt = now(); mutate(tenantId, actor, 'customs.updated', 'customs', declaration.id, before, declaration, 'customs.updated'); return clone(declaration); }
export type ShipmentEventInput = { code: string; location: string; occurredAt?: string; note?: string; eventId?: string };
export type ShipmentEventResult = { shipment: Shipment; outcome: 'applied' | 'duplicate' | 'superseded'; reason: string };

// 事件时间边界：轨迹按 occurredAt 排序，只有"最新"事件才能推进当前位置与运单状态；
// 迟到事件和已交付后的补充事件只追加原始轨迹并留审计，不改写状态、不发 outbox。
function applyShipmentEvent(tenantId: string, shipment: Shipment, input: ShipmentEventInput, actor: string): ShipmentEventResult {
  const occurredAt = input.occurredAt ?? now();
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error('事件发生时间不合法');
  const fingerprint = `${input.code}|${input.location}|${occurredAt}`;
  if (shipment.events.some(item => (input.eventId && item.eventId === input.eventId) || (!input.eventId && `${item.code}|${item.location}|${item.occurredAt}` === fingerprint))) {
    return { shipment: clone(shipment), outcome: 'duplicate', reason: `轨迹事件 ${input.eventId ?? fingerprint} 已存在，重复上传被忽略` };
  }
  const event = { id: id('TRK'), eventId: input.eventId, code: input.code, location: input.location, occurredAt, note: input.note };
  shipment.events.push(event);
  shipment.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const isLatest = shipment.events[shipment.events.length - 1]?.id === event.id;
  if (!isLatest || shipment.status === 'delivered') {
    const reason = shipment.status === 'delivered'
      ? `运输单已交付（终态），${input.code} 事件仅按事件时间追加到原始轨迹，当前位置与状态不变`
      : `迟到轨迹：${input.code} 事件时间 ${occurredAt} 早于已接收的最新轨迹，仅按事件时间插入原始轨迹，当前位置与状态不变`;
    record(tenantId, actor, 'shipment.event.superseded', 'shipment', shipment.id, undefined, { event, reason });
    return { shipment: clone(shipment), outcome: 'superseded', reason };
  }
  shipment.currentLocation = input.location;
  if (input.code === 'DEPARTED') { shipment.status = 'in_transit'; shipment.legs[0].status = 'in_transit'; }
  if (input.code === 'DELAYED') { shipment.status = 'exception'; const leg = shipment.legs.find(item => item.status !== 'arrived'); if (leg) leg.status = 'delayed'; createApproval(tenantId, { orderId: shipment.orderId, type: 'delay_compensation', reason: `运输轨迹 ${shipment.trackingNo} 发生延误` }, actor); }
  if (input.code === 'ARRIVED') shipment.legs[shipment.legs.length - 1].status = 'arrived';
  record(tenantId, actor, 'shipment.event.added', 'shipment', shipment.id, undefined, event);
  emit(tenantId, 'shipment.event.added', shipment.id, event);
  return { shipment: clone(shipment), outcome: 'applied', reason: '轨迹事件已应用' };
}

export function addShipmentEvent(tenantId: string, shipmentId: string, input: ShipmentEventInput, actor = 'system') { const shipment = assertTenant(state.shipments.find(item => item.id === shipmentId) ?? (() => { throw new Error('运输单不存在'); })(), tenantId); if (!input.code || !input.location) throw new Error('轨迹编码和位置不能为空'); return applyShipmentEvent(tenantId, shipment, input, actor); }

export function generateInvoice(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const existing = state.invoices.find(item => item.orderId === orderId); if (existing) return clone(existing); if (!['allocated', 'dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('订单完成库存分配后才能开票'); const freight = money(Math.max(120, order.totalWeightKg * (order.priority === 'critical' ? 4.2 : 2.1))); const fuel = money(freight * 0.13); const customsFee = money(95 + order.items.length * 25); const lines: InvoiceLine[] = [{ code: 'GOODS', description: '货物服务费', quantity: 1, unitPrice: order.subtotal, amount: order.subtotal }, { code: 'FREIGHT', description: '跨境运输费', quantity: 1, unitPrice: freight, amount: freight }, { code: 'FUEL', description: '燃油附加费', quantity: 1, unitPrice: fuel, amount: fuel }, { code: 'CUSTOMS', description: '关务服务费', quantity: 1, unitPrice: customsFee, amount: customsFee }]; const subtotal = money(lines.reduce((sum, line) => sum + line.amount, 0)); const tax = money(subtotal * 0.06); const invoice: Invoice = { id: id('INV'), tenantId, orderId, number: `INV-${new Date().getFullYear()}-${String(state.invoices.length + 1).padStart(5, '0')}`, status: 'issued', currency: order.currency, lines, subtotal, tax, total: money(subtotal + tax), paid: 0, dueDate: new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: now() }; state.invoices.push(invoice); order.invoiceId = invoice.id; mutate(tenantId, actor, 'invoice.issued', 'invoice', invoice.id, undefined, invoice, 'invoice.issued'); return clone(invoice); }
export function recordPayment(tenantId: string, input: { invoiceId: string; amount: number; method: Payment['method']; reference: string }, actor = 'system') { const invoice = assertTenant(state.invoices.find(item => item.id === input.invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId); if (!input.amount || input.amount <= 0 || input.amount > invoice.total - invoice.paid + 0.01) throw new Error('收款金额超过发票未核销余额'); const before = clone(invoice); const payment: Payment = { id: id('PAY'), tenantId, invoiceId: invoice.id, amount: money(input.amount), method: input.method, reference: input.reference, receivedAt: now() }; state.payments.push(payment); invoice.paid = money(invoice.paid + payment.amount); invoice.status = invoice.paid >= invoice.total - 0.01 ? 'paid' : 'partially_paid'; if (invoice.status === 'paid') { const order = state.orders.find(item => item.id === invoice.orderId); if (order && order.status === 'delivered') { const orderBefore = clone(order); transition(order, 'closed'); const customer = customerFor(tenantId, order.customerId); customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.closed', 'order', order.id, orderBefore, order, 'order.closed'); } } mutate(tenantId, actor, 'payment.recorded', 'invoice', invoice.id, before, invoice, 'payment.recorded'); return clone(payment); }

export function createApproval(tenantId: string, input: { orderId: string; type: Approval['type']; reason: string }, actor = 'system') { orderFor(tenantId, input.orderId); const approval: Approval = { id: id('APR'), tenantId, orderId: input.orderId, type: input.type, reason: input.reason, status: 'pending', createdAt: now() }; state.approvals.push(approval); record(tenantId, actor, 'approval.created', 'approval', approval.id, undefined, approval); emit(tenantId, 'approval.created', approval.id, approval); return clone(approval); }
export function decideApproval(tenantId: string, approvalId: string, input: { status: Exclude<ApprovalStatus, 'pending'>; comment?: string }, actor: string) { const approval = assertTenant(state.approvals.find(item => item.id === approvalId) ?? (() => { throw new Error('审批不存在'); })(), tenantId); if (approval.status !== 'pending') throw new Error('审批已经决策'); const before = clone(approval); approval.status = input.status; approval.decidedBy = actor; approval.comment = input.comment; approval.decidedAt = now(); if (input.status === 'approved' && approval.type === 'credit_override') { const order = orderFor(tenantId, approval.orderId); const customer = customerFor(tenantId, order.customerId); customer.creditLimit = Math.max(customer.creditLimit, customer.creditUsed + order.totalAmount); } mutate(tenantId, actor, 'approval.decided', 'approval', approval.id, before, approval, 'approval.decided'); return clone(approval); }

export function operationSummary(tenantId: string) { tenant(tenantId); const orders = listOrders(tenantId); const invoices = state.invoices.filter(item => item.tenantId === tenantId); const shipments = state.shipments.filter(item => item.tenantId === tenantId); return { tenantId, generatedAt: now(), orderCount: orders.length, byStatus: orders.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}), grossMerchandiseValue: money(orders.reduce((sum, item) => sum + item.totalAmount, 0)), receivable: money(invoices.reduce((sum, item) => sum + item.total - item.paid, 0)), paid: money(invoices.reduce((sum, item) => sum + item.paid, 0)), delayedShipments: shipments.filter(item => item.status === 'exception').length, pendingApprovals: state.approvals.filter(item => item.tenantId === tenantId && item.status === 'pending').length, inventory: state.inventory.filter(item => item.tenantId === tenantId).map(item => ({ warehouse: item.warehouse, sku: item.sku, available: item.available, reserved: item.reserved, free: item.available - item.reserved })) }; }
export function timeline(tenantId: string, orderId: string) { const order = orderFor(tenantId, orderId); const relatedIds = new Set([order.id]); const shipment = state.shipments.find(item => item.orderId === orderId); const customs = state.customs.find(item => item.orderId === orderId); const invoice = state.invoices.find(item => item.orderId === orderId); if (shipment) relatedIds.add(shipment.id); if (customs) relatedIds.add(customs.id); if (invoice) relatedIds.add(invoice.id); state.approvals.filter(item => item.orderId === orderId).forEach(item => relatedIds.add(item.id)); return state.audit.filter(item => item.tenantId === tenantId && relatedIds.has(item.entityId)).sort((a, b) => b.at.localeCompare(a.at)).map(clone); }
export function listAudit(tenantId: string, limit = 100) { tenant(tenantId); return state.audit.filter(item => item.tenantId === tenantId).slice(0, Math.min(limit, 500)).map(clone); }
export function listOutbox(tenantId: string, status?: OutboxEvent['status']) { tenant(tenantId); return state.outbox.filter(item => (!status || item.status === status)).map(clone); }
export function publishOutbox(tenantId: string, eventId: string, actor = 'system') { const event = assertTenant(state.outbox.find(item => item.id === eventId) ?? (() => { throw new Error('事件不存在'); })(), tenantId); if (event.status === 'published') return clone(event); event.status = 'published'; event.attempts += 1; record(tenantId, actor, 'outbox.published', 'outbox', event.id, { status: 'pending' }, event); return clone(event); }


export type OrderPage = { items: Order[]; nextCursor?: string; total: number };
export function listOrdersPage(tenantId: string, input: { cursor?: string; limit?: number } = {}) {
  tenant(tenantId);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const ordered = state.orders.filter(item => item.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const items = ordered.slice(offset, offset + limit).map(clone);
  return { items, nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined, total: ordered.length };
}
export function invoiceOverdue(tenantId: string, invoiceId: string, asOf = new Date()) {
  const invoice = assertTenant(state.invoices.find(item => item.id === invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId);
  const order = orderFor(tenantId, invoice.orderId);
  const customer = customerFor(tenantId, order.customerId);
  const customerDate = asOf.toISOString().slice(0, 10);
  return { invoiceId, overdue: customerDate > invoice.dueDate.slice(0, 10), evaluatedDate: customerDate, customerTimezone: customer.timezone ?? 'UTC' };
}

// seed a coherent flow for demos: one order is allocated, one customs declaration is cleared, and one invoice is partially paid.
const seeded = createOrder('tenant-acme', { customerId: 'CUS-001', reference: 'PO-2026-0918', origin: '上海保税区', destination: '鹿特丹', priority: 'urgent', items: [{ sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 10, unitPrice: 180, weightKg: 2.4, hsCode: '9025.19' }, { sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 4, unitPrice: 420, weightKg: 3.2, hsCode: '8537.10' }] });
confirmOrder('tenant-acme', seeded.id); allocateOrder('tenant-acme', seeded.id); const seededDeclaration = createCustomsDeclaration('tenant-acme', { orderId: seeded.id }); updateCustoms('tenant-acme', seededDeclaration.id, { documentRefs: ['commercial-invoice', 'packing-list', 'origin-certificate'], status: 'submitted' }); updateCustoms('tenant-acme', seededDeclaration.id, { status: 'cleared' }); dispatchOrder('tenant-acme', seeded.id); const seededInvoice = generateInvoice('tenant-acme', seeded.id); recordPayment('tenant-acme', { invoiceId: seededInvoice.id, amount: 500, method: 'bank_transfer', reference: 'BANK-DEMO-001' });
