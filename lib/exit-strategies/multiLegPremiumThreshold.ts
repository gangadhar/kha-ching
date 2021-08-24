import dayjs from 'dayjs'
import { KiteOrder } from '../../types/kite'
import { ATM_STRADDLE_TRADE, ATM_STRANGLE_TRADE } from '../../types/trade'
import { USER_OVERRIDE } from '../constants'
import console from '../logging'
import { addToNextQueue, EXIT_TRADING_Q_NAME } from '../queue'
import { getTimeLeftInMarketClosingMs, syncGetKiteInstance, getInstrumentPrice, withRemoteRetry, patchDbTrade } from '../utils'

import { doSquareOffPositions } from './autoSquareOff'

const patchTradeWithTrailingSL = async ({ dbId, trailingSl }) => {
  try {
    await patchDbTrade({
      _id: dbId,
      patchProps: {
        liveTrailingSl: trailingSl,
        lastTrailingSlSetAt: dayjs().format()
      }
    })
  } catch (e) {
    console.log('🔴 [patchTradeWithTrailingSL] error', e)
  }
}

const tradeHeartbeat = async (dbId) => {
  const data = await patchDbTrade({
    _id: dbId,
    patchProps: {
      lastHeartbeatAt: dayjs().format()
    }
  })

  return data
}

export type CombinedPremiumJobDataInterface = (ATM_STRADDLE_TRADE | ATM_STRANGLE_TRADE) & {
  lastTrailingSlTriggerAtPremium?: number
}

async function multiLegPremiumThreshold ({ initialJobData, rawKiteOrdersResponse, squareOffOrders }: {
  initialJobData: CombinedPremiumJobDataInterface
  rawKiteOrdersResponse: KiteOrder[]
  squareOffOrders?: KiteOrder[]
}) {
  try {
    if (getTimeLeftInMarketClosingMs() < 0) {
      return Promise.resolve(
        '🟢 [multiLegPremiumThreshold] Terminating Combined Premium checker as market closing...'
      )
    }

    const { slmPercent, trailingSlPercent, user, trailEveryPercentageChangeValue, lastTrailingSlTriggerAtPremium, _id: dbId } = initialJobData
    const kite = syncGetKiteInstance(user)

    try {
      // notify db that the worker is active and check current user override settings
      const dbTrade = await withRemoteRetry(async () => tradeHeartbeat(dbId))
      if (dbTrade.user_override === USER_OVERRIDE.ABORT) {
        return Promise.resolve(
          '🟢 [multiLegPremiumThreshold] Terminating Combined Premium checker as status ABORTed'
        )
      }
    } catch (error) {
      // harmless error, log and continue processing
      console.log('🔴 [multiLegPremiumThreshold] tradeHeartbeat error', error)
    }

    /**
     * Trailing SL method
     * 1. initial total SL = initialPremiumReceived + sl% * initialPremiumReceived
     * 2. trailing SL
     *    on every decrease in combined premium by X%, trail the SL by initial SL %
     *
     * e.g. at 9.20am
     * initial premium = 400 = lastInflectionPoint
     * initial SL = 10%
     * total SL = 440
     *
     *
     * At 10.00am
     * combined premium = 380
     * decrease in premium = 5%
     * new SL = 380 + 10% * 380 = 418
     *  terminate this job, add a replica to same queue
     *  with lastTrailingSlTriggerAtPremium = 380
     *
     *
     * At 10.15am
     * combined premium = 390
     * ideal SL = 400 + 10%*440 = 440
     * trailing SL = 418
     * SL = min(ideal SL, trailing SL)
     * no changes
     */

    const legsOrders = rawKiteOrdersResponse
    // check here if the open positions include these legs
    // and quantities should be greater than equal to `legsOrders`
    // if not, resolve this checker assuming the user has squared off the positions themselves

    const tradingSymbols = legsOrders.map((order) => order.tradingsymbol)

    const averageOrderPrices = legsOrders.map((order) => order.average_price)
    const initialPremiumReceived = averageOrderPrices.reduce((sum, price) => sum! + price!, 0)

    let liveSymbolPrices: number[]
    try {
      liveSymbolPrices = await Promise.all(
        tradingSymbols.map(async (symbol) => withRemoteRetry(async () => getInstrumentPrice(kite, symbol, kite.EXCHANGE_NFO)))
      )
    } catch (error) {
      console.log('🔴 [multiLegPremiumThreshold] getInstrumentPrice error', error)
      return Promise.reject(new Error('Kite APIs acting up'))
    }

    const liveTotalPremium = liveSymbolPrices.reduce((sum, price) => sum + price, 0)
    const initialSlTotalPremium = initialPremiumReceived! + (slmPercent / 100 * initialPremiumReceived!) // 440

    let checkAgainstSl = initialSlTotalPremium

    if (trailEveryPercentageChangeValue) {
      const trailingSlTotalPremium = lastTrailingSlTriggerAtPremium
        ? (lastTrailingSlTriggerAtPremium + ((trailingSlPercent ?? slmPercent) / 100 * lastTrailingSlTriggerAtPremium))
        : null // 418
      checkAgainstSl = trailingSlTotalPremium ?? initialSlTotalPremium // 418

      if (liveTotalPremium < checkAgainstSl) {
        const lastInflectionPoint = lastTrailingSlTriggerAtPremium ?? initialPremiumReceived // 380
        // liveTotalPremium = 360
        const changeFromLastInflectionPoint =
          ((liveTotalPremium - lastInflectionPoint!) / lastInflectionPoint!) * 100
        // continue the checker
        if (
          changeFromLastInflectionPoint < 0 &&
          Math.abs(changeFromLastInflectionPoint) >= trailEveryPercentageChangeValue
        ) {
          // update lastTrailingSlTriggerAtPremium
          // if current liveTotalPremium is X% lesser than trailEveryPercentageChangeValue

          // add to same queue with updated params
          try {
            await addToNextQueue({
              ...initialJobData,
              lastTrailingSlTriggerAtPremium: liveTotalPremium
            }, {
              _nextTradingQueue: EXIT_TRADING_Q_NAME,
              rawKiteOrdersResponse,
              squareOffOrders
            })
          } catch (e) {
            console.log('🔴 [multiLegPremiumThreshold] addToNextQueue error', e)
          }

          // update db trade with new combined SL property
          // and expose it in the UI
          try {
            await withRemoteRetry(async () => patchTradeWithTrailingSL({
              dbId,
              trailingSl: (liveTotalPremium + ((trailingSlPercent ?? slmPercent) / 100 * liveTotalPremium))
            }))
          } catch (error) {
            // harmless error, move on
            console.log('🔴 [multiLegPremiumThreshold] patchTradeWithTrailingSL error', error)
          }

          const resolveMsg = `⚡️ [multiLegPremiumThreshold] trailing new inflection point ${liveTotalPremium}`
          console.log(resolveMsg)
          // terminate this worker
          return Promise.resolve(resolveMsg)
        }
      }
    }

    if (liveTotalPremium < checkAgainstSl) {
      const rejectMsg = `🟢 [multiLegPremiumThreshold] liveTotalPremium (${liveTotalPremium}) < threshold (${checkAgainstSl})`
      return Promise.reject(new Error(rejectMsg))
    }

    // terminate the checker
    const exitMsg = `☢️ [multiLegPremiumThreshold] triggered! liveTotalPremium (${liveTotalPremium}) > threshold (${checkAgainstSl})`
    console.log(exitMsg)

    return doSquareOffPositions(squareOffOrders!, kite, initialJobData)
  } catch (e) {
    console.log('☢️ [multiLegPremiumThreshold] terminated', e)
    return Promise.resolve(e)
  }
}

export default multiLegPremiumThreshold