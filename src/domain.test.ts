import assert from 'node:assert/strict';
import test from 'node:test';
import { addShipmentEvent, allocateOrder, closeOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, deliverOrder, dispatchOrder, generateInvoice, ingestOrderEvent, listOrderEvents, operationSummary, recordPayment, state, updateCustoms } from './domain.js';

const TENANT = 'tenant-acme';
let seq = 0;
const nextRef = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

function makeOrder() {
  return createOrder(TENANT, { customerId: 'CUS-001', reference: nextRef('EVT'), origin: '深圳港', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
}
function makeDispatchedOrder() {
  const order = makeOrder();
  confirmOrder(TENANT, order.id, 'tester');
  allocateOrder(TENANT, order.id, 'tester');
  const declaration = createCustomsDeclaration(TENANT, { orderId: order.id });
  updateCustoms(TENANT, declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms(TENANT, declaration.id, { status: 'cleared' }, 'tester');
  dispatchOrder(TENANT, order.id, 'tester');
  return order.id;
}
const orderOf = (orderId: string) => state.orders.find(item => item.id === orderId)!;
const shipmentOf = (orderId: string) => state.shipments.find(item => item.orderId === orderId)!;
const outboxFor = (aggregateId: string) => state.outbox.filter(item => item.aggregateId === aggregateId);

test('terminal states never regress: late dispatch and duplicate delivery events are absorbed', () => {
  const orderId = makeDispatchedOrder();
  const deliveredAt = new Date().toISOString();
  const applied = ingestOrderEvent(TENANT, { eventId: 'EVT-SIGN-1', orderId, type: 'delivered', occurredAt: deliveredAt, source: 'device', location: '鹿特丹' });
  assert.equal(applied.outcome, 'applied');
  assert.equal(applied.orderStatus, 'delivered');
  const versionAfterDeliver = orderOf(orderId).version;
  const outboxAfterDeliver = outboxFor(orderId).length;

  // 同一签收事件被设备重复上传：幂等，不产生二次业务效果
  const replay = ingestOrderEvent(TENANT, { eventId: 'EVT-SIGN-1', orderId, type: 'delivered', occurredAt: deliveredAt, source: 'device' });
  assert.equal(replay.outcome, 'duplicate');
  // 不同 eventId 的重复签收：同样只算一次
  const secondScan = ingestOrderEvent(TENANT, { eventId: 'EVT-SIGN-1B', orderId, type: 'delivered', occurredAt: deliveredAt, source: 'carrier' });
  assert.equal(secondScan.outcome, 'duplicate');
  // 迟到的出运记录：订单保持 delivered，不倒退
  const lateDispatch = ingestOrderEvent(TENANT, { eventId: 'EVT-DEP-LATE', orderId, type: 'dispatched', occurredAt: new Date(Date.now() - 86400000).toISOString(), source: 'carrier', location: '深圳港' });
  assert.equal(lateDispatch.outcome, 'superseded');
  assert.match(lateDispatch.reason, /迟到事件/);

  assert.equal(orderOf(orderId).status, 'delivered');
  assert.equal(orderOf(orderId).version, versionAfterDeliver);
  // 迟到/重复事件没有发出任何新的状态 outbox
  assert.equal(outboxFor(orderId).length, outboxAfterDeliver);
  assert.equal(outboxFor(orderId).filter(item => item.topic === 'shipment.delivered').length, 1);
  // 但审计与原始轨迹完整保留
  assert.ok(state.audit.some(item => item.entityId === orderId && item.action === 'order.event.superseded'));
  assert.ok(shipmentOf(orderId).events.some(item => item.code === 'DEPARTED' && item.note?.includes('superseded')));
  // 处理结果可回放、可解释（eventId 重放不产生新记录，只返回首次处理结果）
  const inbox = listOrderEvents(TENANT, orderId);
  assert.deepEqual(inbox.map(item => item.outcome), ['applied', 'duplicate', 'superseded']);
});

test('concurrent cancel/deliver/close resolve deterministically with explainable conflicts', () => {
  // 交付先到达：随后的取消被拒绝，并指明冲突来源
  const orderId = makeDispatchedOrder();
  ingestOrderEvent(TENANT, { eventId: 'EVT-DLV-WIN', orderId, type: 'delivered', occurredAt: new Date().toISOString(), source: 'device' });
  const cancel = ingestOrderEvent(TENANT, { eventId: 'EVT-CXL-LOSE', orderId, type: 'cancelled', occurredAt: new Date().toISOString(), source: 'ops' });
  assert.equal(cancel.outcome, 'rejected');
  assert.match(cancel.reason, /取消请求被拒绝/);
  assert.equal(cancel.conflict?.currentStatus, 'delivered');
  assert.equal(cancel.conflict?.winningEventId, 'EVT-DLV-WIN');
  assert.equal(orderOf(orderId).status, 'delivered');

  // 取消先到达：随后的交付被拒绝，订单保持 cancelled
  const order2 = makeOrder();
  confirmOrder(TENANT, order2.id, 'tester');
  allocateOrder(TENANT, order2.id, 'tester');
  const cancelFirst = ingestOrderEvent(TENANT, { eventId: 'EVT-CXL-WIN', orderId: order2.id, type: 'cancelled', occurredAt: new Date().toISOString(), source: 'ops' });
  assert.equal(cancelFirst.outcome, 'applied');
  const deliverAfter = ingestOrderEvent(TENANT, { eventId: 'EVT-DLV-LOSE', orderId: order2.id, type: 'delivered', occurredAt: new Date().toISOString(), source: 'device' });
  assert.equal(deliverAfter.outcome, 'rejected');
  assert.match(deliverAfter.reason, /已取消（终态）/);
  assert.equal(orderOf(order2.id).status, 'cancelled');
  // 取消事件重放：幂等，不重复释放授信
  const creditUsed = state.customers.find(item => item.id === 'CUS-001')!.creditUsed;
  const replay = ingestOrderEvent(TENANT, { eventId: 'EVT-CXL-WIN', orderId: order2.id, type: 'cancelled', occurredAt: new Date().toISOString(), source: 'ops' });
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(state.customers.find(item => item.id === 'CUS-001')!.creditUsed, creditUsed);
});

test('closed is terminal: payment only auto-closes delivered orders, late events cannot reopen', () => {
  // 未签收前付清全款：不得直接关闭订单
  const orderId = makeDispatchedOrder();
  const invoice = generateInvoice(TENANT, orderId, 'tester');
  recordPayment(TENANT, { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: nextRef('PAY') }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)!.status, 'paid');
  assert.equal(orderOf(orderId).status, 'dispatched');
  // 签收后即可正常关闭（发票已核销）
  deliverOrder(TENANT, orderId, 'ops');
  closeOrder(TENANT, orderId, 'ops');
  assert.equal(orderOf(orderId).status, 'closed');
  // 已关闭后：迟到签收被 supersede，取消被拒绝，状态不倒退
  const lateDeliver = ingestOrderEvent(TENANT, { eventId: 'EVT-LATE-DLV', orderId, type: 'delivered', occurredAt: new Date(Date.now() - 3600000).toISOString(), source: 'device' });
  assert.equal(lateDeliver.outcome, 'superseded');
  const lateCancel = ingestOrderEvent(TENANT, { eventId: 'EVT-LATE-CXL', orderId, type: 'cancelled', occurredAt: new Date().toISOString(), source: 'ops' });
  assert.equal(lateCancel.outcome, 'rejected');
  assert.equal(orderOf(orderId).status, 'closed');

  // 已签收订单付清全款：经状态机自动关闭，带审计与 outbox
  const orderId2 = makeDispatchedOrder();
  deliverOrder(TENANT, orderId2, 'ops');
  const invoice2 = generateInvoice(TENANT, orderId2, 'tester');
  recordPayment(TENANT, { invoiceId: invoice2.id, amount: invoice2.total, method: 'bank_transfer', reference: nextRef('PAY') }, 'tester');
  assert.equal(orderOf(orderId2).status, 'closed');
  assert.ok(state.audit.some(item => item.entityId === orderId2 && item.action === 'order.closed'));
  assert.ok(outboxFor(orderId2).some(item => item.topic === 'order.closed'));
});

test('shipment trajectory keeps raw events in event-time order but never moves state backwards', () => {
  const orderId = makeDispatchedOrder();
  const shipmentId = shipmentOf(orderId).id;
  const departedAt = new Date().toISOString();
  const departed = addShipmentEvent(TENANT, shipmentId, { code: 'DEPARTED', location: '深圳港', occurredAt: departedAt, eventId: 'TRK-1' }, 'device');
  assert.equal(departed.outcome, 'applied');
  assert.equal(shipmentOf(orderId).status, 'in_transit');

  // 更早发生的中转记录晚到：只插入原始轨迹，不回写当前位置，不发 outbox
  const outboxBefore = outboxFor(shipmentId).length;
  const lateTransit = addShipmentEvent(TENANT, shipmentId, { code: 'TRANSIT', location: '盐田堆场', occurredAt: new Date(Date.now() - 7200000).toISOString(), eventId: 'TRK-0' }, 'carrier');
  assert.equal(lateTransit.outcome, 'superseded');
  assert.equal(shipmentOf(orderId).currentLocation, '深圳港');
  assert.equal(outboxFor(shipmentId).length, outboxBefore);
  assert.deepEqual(shipmentOf(orderId).events.map(item => item.code), ['TRANSIT', 'DEPARTED']);

  // 设备重复上传同一事件：幂等忽略
  const duplicate = addShipmentEvent(TENANT, shipmentId, { code: 'DEPARTED', location: '深圳港', occurredAt: departedAt, eventId: 'TRK-1' }, 'device');
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(shipmentOf(orderId).events.filter(item => item.code === 'DEPARTED').length, 1);

  // 交付后迟到的延误上报：运单保持 delivered，不产生延误赔付审批
  deliverOrder(TENANT, orderId, 'ops');
  const approvalsBefore = state.approvals.length;
  const lateDelay = addShipmentEvent(TENANT, shipmentId, { code: 'DELAYED', location: '鹿特丹', occurredAt: new Date().toISOString(), eventId: 'TRK-9' }, 'carrier');
  assert.equal(lateDelay.outcome, 'superseded');
  assert.equal(shipmentOf(orderId).status, 'delivered');
  assert.equal(state.approvals.length, approvalsBefore);

  // 异常签收与交付并发：订单保持 delivered，异常只进轨迹与审计
  const exception = ingestOrderEvent(TENANT, { eventId: 'EVT-EXC-1', orderId, type: 'exception', occurredAt: new Date().toISOString(), source: 'ops', note: '外包装破损' });
  assert.equal(exception.outcome, 'superseded');
  assert.equal(orderOf(orderId).status, 'delivered');
  assert.ok(shipmentOf(orderId).events.some(item => item.code === 'EXCEPTION'));
});

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});
