import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import {
  CTFExchange,
  FeeCharged,
  NewAdmin,
  NewOperator,
  OrderCancelled,
  OrderFilled,
  OrdersMatched,
  ProxyFactoryUpdated,
  RemovedAdmin,
  RemovedOperator,
  SafeFactoryUpdated,
  TokenRegistered,
  TradingPaused,
  TradingUnpaused
} from "../generated/CTFExchange/CTFExchange"
import { ExampleEntity } from "../generated/schema"

export function handleFeeCharged(event: FeeCharged): void {
  // Entities can be loaded from the store using an ID; this ID
  // needs to be unique across all entities of the same type
  const id = event.transaction.hash.concat(
    Bytes.fromByteArray(Bytes.fromBigInt(event.logIndex))
  )
  let entity = ExampleEntity.load(id)

  // Entities only exist after they have been saved to the store;
  // `null` checks allow to create entities on demand
  if (!entity) {
    entity = new ExampleEntity(id)

    // Entity fields can be set using simple assignments
    entity.count = BigInt.fromI32(0)
  }

  // BigInt and BigDecimal math are supported
  entity.count = entity.count + BigInt.fromI32(1)

  // Entity fields can be set based on event parameters
  entity.receiver = event.params.receiver
  entity.tokenId = event.params.tokenId

  // Entities can be written to the store with `.save()`
  entity.save()

  // Note: If a handler doesn't require existing field values, it is faster
  // _not_ to load the entity from the store. Instead, create it fresh with
  // `new Entity(...)`, set the fields that should be updated and save the
  // entity back to the store. Fields that were not set or unset remain
  // unchanged, allowing for partial updates to be applied.

  // It is also possible to access smart contracts from mappings. For
  // example, the contract that has emitted the event can be connected to
  // with:
  //
  // let contract = Contract.bind(event.address)
  //
  // The following functions can then be called on this contract to access
  // state variables and other data:
  //
  // - contract.admins(...)
  // - contract.domainSeparator(...)
  // - contract.getCollateral(...)
  // - contract.getComplement(...)
  // - contract.getConditionId(...)
  // - contract.getCtf(...)
  // - contract.getMaxFeeRate(...)
  // - contract.getOrderStatus(...)
  // - contract.getPolyProxyFactoryImplementation(...)
  // - contract.getPolyProxyWalletAddress(...)
  // - contract.getProxyFactory(...)
  // - contract.getSafeAddress(...)
  // - contract.getSafeFactory(...)
  // - contract.getSafeFactoryImplementation(...)
  // - contract.hashOrder(...)
  // - contract.isAdmin(...)
  // - contract.isOperator(...)
  // - contract.isValidNonce(...)
  // - contract.nonces(...)
  // - contract.onERC1155BatchReceived(...)
  // - contract.onERC1155Received(...)
  // - contract.operators(...)
  // - contract.orderStatus(...)
  // - contract.parentCollectionId(...)
  // - contract.paused(...)
  // - contract.proxyFactory(...)
  // - contract.registry(...)
  // - contract.safeFactory(...)
  // - contract.supportsInterface(...)
}

export function handleNewAdmin(event: NewAdmin): void {}

export function handleNewOperator(event: NewOperator): void {}

export function handleOrderCancelled(event: OrderCancelled): void {}

export function handleOrderFilled(event: OrderFilled): void {}

export function handleOrdersMatched(event: OrdersMatched): void {}

export function handleProxyFactoryUpdated(event: ProxyFactoryUpdated): void {}

export function handleRemovedAdmin(event: RemovedAdmin): void {}

export function handleRemovedOperator(event: RemovedOperator): void {}

export function handleSafeFactoryUpdated(event: SafeFactoryUpdated): void {}

export function handleTokenRegistered(event: TokenRegistered): void {}

export function handleTradingPaused(event: TradingPaused): void {}

export function handleTradingUnpaused(event: TradingUnpaused): void {}
