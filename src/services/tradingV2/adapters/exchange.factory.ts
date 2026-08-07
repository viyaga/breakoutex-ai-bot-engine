import { TradingConfig } from "../config";
import { BinanceExchangeAdapter } from "./binance.adapter";
import { DeltaExchangeAdapter } from "./delta.adapter";
import { ZerodhaAdapter } from "./zerodha.adapter";
import { AngelOneAdapter } from "./angelone.adapter";
import { IExchangeAdapter } from "./IExchangeAdapter";
import { tradingCronLogger } from "../logger";

export class ExchangeAdapterFactory {
    /**
     * Registry-driven adapter map.
     * To add a new exchange: add an entry here + create the adapter class.
     * No switch-case changes needed anywhere else.
     */
    private static readonly adapterMap: Record<string, IExchangeAdapter> = {
        delta:    new DeltaExchangeAdapter(),
        binance:  new BinanceExchangeAdapter(),
        zerodha:  new ZerodhaAdapter(),
        angelone: new AngelOneAdapter(),
    };

    static getAdapterForExchange(exchangeName: string): IExchangeAdapter {
        const ex = (exchangeName || "delta").toLowerCase();
        const adapter = this.adapterMap[ex];
        if (!adapter) {
            tradingCronLogger.warn(`[ExchangeAdapterFactory] Unrecognized exchange "${exchangeName}", falling back to delta`);
            return this.adapterMap["delta"];
        }
        return adapter;
    }

    static getAdapter(): IExchangeAdapter {
        let exchange = "delta";
        try {
            const config = TradingConfig.getConfig();
            if (config?.EXCHANGE) {
                exchange = config.EXCHANGE.toLowerCase();
            }
        } catch {
            // Fallback to default exchange if no config context stored
        }
        return this.getAdapterForExchange(exchange);
    }
}
