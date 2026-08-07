import { ActiveSubscribedBot, CancelAllOrdersFilter, ConfigType, OrderDetails, OrderSide, TickerData } from "../type";
import { IExchangeAdapter } from "./IExchangeAdapter";
import { tradingCronLogger } from "../logger";
import { decrypt } from "../../../utils/crypto";

/**
 * AngelOneAdapter — Implements IExchangeAdapter for AngelOne SmartAPI.
 *
 * Authentication: TOTP auto-login (fully automated — no user action needed daily).
 *   - clientCode, mpin, and totpSecret are stored encrypted in the Exchanges collection.
 *   - Backend /api/exchanges/angelone/refresh-session auto-generates TOTP and refreshes jwtToken.
 *   - This adapter reads the decrypted jwtToken per-bot from ConfigType.
 *
 * Note: AngelOne is an equity/F&O broker. Leverage is not applicable for equity.
 *
 * TODO: Full SmartAPI integration after backend session refresh endpoint is live.
 */
export class AngelOneAdapter implements IExchangeAdapter {
    readonly exchangeName = "angelone";

    mapSymbol(symbol: string): string {
        // AngelOne uses NSE/BSE symbol tokens (integers), not string symbols.
        // Symbol resolution will be handled per-bot via instrument lookup.
        return symbol;
    }

    prepareConfig(
        bot: ActiveSubscribedBot,
        defaultConfig: Partial<ConfigType>,
        _productDataMap: Map<string, any>
    ): ConfigType {
        const config: ConfigType = {
            ...defaultConfig,
            ...bot,
            id: bot.id,
            EXCHANGE: this.exchangeName,
            API_KEY: decrypt(bot.API_KEY),
            SECRET_KEY: decrypt(bot.SECRET_KEY),
            BASE_URL: "https://apiconnect.angelone.in",
            LOT_SIZE: 1,
            PRODUCT_ID: Number(bot.PRODUCT_ID) || 0,
            SYMBOL: bot.SYMBOL,
        } as ConfigType;

        if (!config.PRICE_DECIMAL_PLACES) config.PRICE_DECIMAL_PLACES = 2;

        tradingCronLogger.info(`[AngelOneAdapter] ✓ Configured bot ${config.id} [${bot.SYMBOL}]`);
        return config;
    }

    async getCandlestickData(symbol: string, resolution: string, start: number, end: number): Promise<any> {
        // TODO: POST /rest/secure/angelbroking/historical/v1/getCandleData
        // Requires symboltoken (instrument token), exchange, interval, fromdate, todate
        tradingCronLogger.warn(`[AngelOneAdapter] getCandlestickData not yet implemented for ${symbol}`);
        return [];
    }

    async getTickerData(symbol: string): Promise<TickerData | null> {
        // TODO: POST /rest/secure/angelbroking/market/v1/quote
        tradingCronLogger.warn(`[AngelOneAdapter] getTickerData not yet implemented for ${symbol}`);
        return null;
    }

    async getOrderDetails(id: string): Promise<OrderDetails | null> {
        // TODO: GET /rest/secure/angelbroking/order/v1/details/{uniqueOrderId}
        tradingCronLogger.warn(`[AngelOneAdapter] getOrderDetails not yet implemented for ${id}`);
        return null;
    }

    async placeEntryOrder(symbol: string, side: OrderSide, qty: number, cid?: string): Promise<any> {
        // TODO: POST /rest/secure/angelbroking/order/v1/placeOrder
        tradingCronLogger.warn(`[AngelOneAdapter] placeEntryOrder not yet implemented`);
        return { success: false, error: "AngelOneAdapter: placeEntryOrder not implemented" };
    }

    async placeTPSLBracketOrder(
        tp: number,
        sl: number,
        side: OrderSide,
        logContext?: any,
        entryPrice?: number
    ): Promise<{ success: boolean; ids: { tp: string; sl: string }; isNoPosition?: boolean }> {
        // TODO: Place GTT (Good Till Triggered) orders for SL and TP
        tradingCronLogger.warn(`[AngelOneAdapter] placeTPSLBracketOrder not yet implemented`);
        return { success: false, ids: { tp: "", sl: "" } };
    }

    async updateStopLossOrder(
        id: number | string,
        slPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        sl: number,
        logContext?: any
    ): Promise<{ success: boolean; slPrice: number; isSlSame?: boolean; isSlReversed?: boolean; isAlreadyTriggered?: boolean }> {
        tradingCronLogger.warn(`[AngelOneAdapter] updateStopLossOrder not yet implemented`);
        return { success: false, slPrice };
    }

    async updateTakeProfitOrder(
        id: number | string,
        tpPrice: number,
        productId: number | string,
        productSymbol: string,
        orderSide: OrderSide,
        tp: number,
        logContext?: any
    ): Promise<{ success: boolean; tpPrice: number; isTpSame?: boolean; isAlreadyTriggered?: boolean }> {
        tradingCronLogger.warn(`[AngelOneAdapter] updateTakeProfitOrder not yet implemented`);
        return { success: false, tpPrice };
    }

    async cancelStopOrders(filter: CancelAllOrdersFilter, logContext?: any): Promise<{ success: boolean }> {
        tradingCronLogger.warn(`[AngelOneAdapter] cancelStopOrders not yet implemented`);
        return { success: false };
    }

    async getPositions(productId?: number | string): Promise<any> {
        // TODO: GET /rest/secure/angelbroking/order/v1/getPosition
        tradingCronLogger.warn(`[AngelOneAdapter] getPositions not yet implemented`);
        return [];
    }

    /** Leverage is not applicable for AngelOne equity — return 1x */
    async getOrderLeverage(_productId: number | string): Promise<any> {
        return { leverage: 1 };
    }

    /** Leverage is not applicable for AngelOne equity — no-op */
    async changeOrderLeverage(_productId: number | string, _leverage: number): Promise<any> {
        return { success: true };
    }
}
