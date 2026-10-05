import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, cancelOrder, closeOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, deliverOrder, dispatchOrder, generateInvoice, getOrder, ingestOrderEvent, operationSummary, recordPayment, state, updateCustoms } from './domain.js';

let seq = 0;
const nextRef = (prefix: string) => `${prefix}-${Date.now()}-${seq++}`;
const buildAllocated = (reference: string) => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference, origin: '深圳港', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  return order;
};
const buildDispatched = (reference: string) => {
  const order = buildAllocated(reference);
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  dispatchOrder('tenant-acme', order.id, 'tester');
  return order;
};
const deliveredOutbox = (orderId: string) => state.outbox.filter(item => item.aggregateId === orderId && item.topic === 'shipment.delivered');

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

test('late and duplicate events never regress a delivered order, but keep audit and raw track', () => {
  const order = buildDispatched(nextRef('LATE'));
  const signed = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGN-${order.id}`, orderId: order.id, code: 'DELIVERED', occurredAt: '2026-10-01T09:00:00.000Z', source: 'device' }, 'device-gw');
  assert.equal(signed.status, 'applied');
  assert.equal(signed.order.status, 'delivered');
  assert.equal(deliveredOutbox(order.id).length, 1);

  // 设备重复上传同一签收事件：幂等返回，不产生第二次业务效果
  const duplicate = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGN-${order.id}`, orderId: order.id, code: 'DELIVERED', occurredAt: '2026-10-01T09:00:00.000Z', source: 'device' }, 'device-gw');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.order.status, 'delivered');
  assert.equal(deliveredOutbox(order.id).length, 1);

  // 承运商延迟上报的出运记录：忽略状态改写，但保留原始轨迹与审计，且不发新 outbox
  const lateDispatch = ingestOrderEvent('tenant-acme', { eventId: `EVT-DEP-${order.id}`, orderId: order.id, code: 'DISPATCHED', occurredAt: '2026-09-28T08:00:00.000Z', source: 'carrier' }, 'carrier-gw');
  assert.equal(lateDispatch.status, 'ignored');
  assert.equal(getOrder('tenant-acme', order.id).status, 'delivered');
  const shipment = state.shipments.find(item => item.orderId === order.id)!;
  assert.ok(shipment.events.some(item => item.code === 'DISPATCHED' && item.occurredAt === '2026-09-28T08:00:00.000Z'));
  assert.ok(state.audit.some(item => item.entityId === order.id && item.action === 'order.event.ignored'));
  assert.equal(deliveredOutbox(order.id).length, 1);

  // 不同 eventId 的重复终态：同样只产生一次业务效果
  const repeatedTerminal = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGN2-${order.id}`, orderId: order.id, code: 'DELIVERED', occurredAt: '2026-10-03T09:00:00.000Z', source: 'device' }, 'device-gw');
  assert.equal(repeatedTerminal.status, 'ignored');
  assert.equal(getOrder('tenant-acme', order.id).status, 'delivered');
  assert.equal(deliveredOutbox(order.id).length, 1);

  // 命令侧同样幂等且不可倒退
  assert.equal(deliverOrder('tenant-acme', order.id, 'tester').status, 'delivered');
  assert.equal(deliveredOutbox(order.id).length, 1);
  assert.throws(() => dispatchOrder('tenant-acme', order.id, 'tester'));
});

test('closed orders stay closed: late cancel/deliver events yield conflicts or ignores', () => {
  const order = buildDispatched(nextRef('CLOSED'));
  ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGN-${order.id}`, orderId: order.id, code: 'DELIVERED', occurredAt: '2026-10-01T09:00:00.000Z' }, 'device-gw');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${order.id}` }, 'tester');
  assert.equal(getOrder('tenant-acme', order.id).status, 'closed');

  // 迟到的取消指令与已关闭状态互斥：冲突可解释，状态不变
  const cancel = ingestOrderEvent('tenant-acme', { eventId: `EVT-CXL-${order.id}`, orderId: order.id, code: 'CANCELLED', occurredAt: '2026-10-02T09:00:00.000Z', source: 'manual' }, 'ops-console');
  assert.equal(cancel.status, 'conflict');
  assert.equal(getOrder('tenant-acme', order.id).status, 'closed');
  assert.ok(state.audit.some(item => item.entityId === order.id && item.action === 'order.event.conflict'));

  // 关闭后迟到的签收补传：忽略，不倒退
  const lateSign = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGNB-${order.id}`, orderId: order.id, code: 'DELIVERED', occurredAt: '2026-10-02T10:00:00.000Z' }, 'device-gw');
  assert.equal(lateSign.status, 'ignored');
  assert.equal(getOrder('tenant-acme', order.id).status, 'closed');
  assert.throws(() => dispatchOrder('tenant-acme', order.id, 'tester'));
  assert.throws(() => cancelOrder('tenant-acme', order.id, 'tester'));
  assert.equal(closeOrder('tenant-acme', order.id, 'tester').status, 'closed');
});

test('concurrent cancel and deliver events resolve deterministically with explainable results', () => {
  const allocated = buildAllocated(nextRef('RACE'));
  const cancelled = ingestOrderEvent('tenant-acme', { eventId: `EVT-CXL-${allocated.id}`, orderId: allocated.id, code: 'CANCELLED', occurredAt: '2026-10-01T08:00:00.000Z', source: 'manual' }, 'ops-console');
  assert.equal(cancelled.status, 'applied');
  assert.equal(cancelled.order.status, 'cancelled');

  // 取消后到达的签收：冲突，状态保持 cancelled，可重复上传结果稳定
  const signAfterCancel = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGN-${allocated.id}`, orderId: allocated.id, code: 'DELIVERED', occurredAt: '2026-10-01T09:00:00.000Z', source: 'device' }, 'device-gw');
  assert.equal(signAfterCancel.status, 'conflict');
  assert.equal(getOrder('tenant-acme', allocated.id).status, 'cancelled');
  const signAgain = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGN-${allocated.id}`, orderId: allocated.id, code: 'DELIVERED', occurredAt: '2026-10-01T09:00:00.000Z', source: 'device' }, 'device-gw');
  assert.equal(signAgain.status, 'duplicate');
  assert.equal(getOrder('tenant-acme', allocated.id).status, 'cancelled');

  // 已出运订单的取消：拒绝并说明原因，状态不变
  const dispatchedOrder = buildDispatched(nextRef('RACE2'));
  const cancelDispatched = ingestOrderEvent('tenant-acme', { eventId: `EVT-CXL-${dispatchedOrder.id}`, orderId: dispatchedOrder.id, code: 'CANCELLED', occurredAt: '2026-10-01T08:00:00.000Z', source: 'manual' }, 'ops-console');
  assert.equal(cancelDispatched.status, 'rejected');
  assert.match(cancelDispatched.reason, /已出运订单不能取消/);
  assert.equal(getOrder('tenant-acme', dispatchedOrder.id).status, 'dispatched');
});

test('exception sign-off is idempotent and keeps a single business effect', () => {
  const order = buildDispatched(nextRef('EXC'));
  const first = ingestOrderEvent('tenant-acme', { eventId: `EVT-EXC-${order.id}`, orderId: order.id, code: 'DELIVERED_EXCEPTION', occurredAt: '2026-10-01T09:00:00.000Z', note: '外包装破损，收货人异议签收', source: 'device' }, 'device-gw');
  assert.equal(first.status, 'applied');
  assert.equal(first.order.status, 'delivered');
  assert.equal(state.shipments.find(item => item.orderId === order.id)!.status, 'exception');
  assert.ok(state.audit.some(item => item.entityId === order.id && item.action === 'order.delivered.exception'));

  // 并发的正常签收后到：重复终态被忽略，只有一条 delivered outbox
  const second = ingestOrderEvent('tenant-acme', { eventId: `EVT-SIGNN-${order.id}`, orderId: order.id, code: 'DELIVERED', occurredAt: '2026-10-01T09:05:00.000Z', source: 'carrier' }, 'carrier-gw');
  assert.equal(second.status, 'ignored');
  assert.equal(getOrder('tenant-acme', order.id).status, 'delivered');
  assert.equal(deliveredOutbox(order.id).length, 1);
});

test('full payment only auto-closes delivered orders and records audit plus outbox', () => {
  const order = buildDispatched(nextRef('PAY'));
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${order.id}` }, 'tester');
  assert.equal(getOrder('tenant-acme', order.id).status, 'dispatched');

  deliverOrder('tenant-acme', order.id, 'tester');
  closeOrder('tenant-acme', order.id, 'tester');
  assert.equal(getOrder('tenant-acme', order.id).status, 'closed');
  assert.equal(closeOrder('tenant-acme', order.id, 'tester').status, 'closed');

  const order2 = buildDispatched(nextRef('PAY2'));
  deliverOrder('tenant-acme', order2.id, 'tester');
  const invoice2 = generateInvoice('tenant-acme', order2.id, 'tester');
  recordPayment('tenant-acme', { invoiceId: invoice2.id, amount: invoice2.total, method: 'bank_transfer', reference: `PAY-${order2.id}` }, 'tester');
  assert.equal(getOrder('tenant-acme', order2.id).status, 'closed');
  assert.ok(state.audit.some(item => item.entityId === order2.id && item.action === 'order.closed'));
  assert.ok(state.outbox.some(item => item.aggregateId === order2.id && item.topic === 'order.closed'));
});
