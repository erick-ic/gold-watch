export const TROY_OUNCE_GRAMS = 31.1034768;

export type InstrumentId = 'xauusd' | 'au9999' | 'autd' | 'zsjcg' | 'msjcg';
type Currency = 'USD' | 'CNY';

export interface InstrumentMeta {
  id: InstrumentId;
  symbol: string;
  name: string;
  nameEn: string;
  venue: string;
  currency: Currency;
  unitLabel: string;
  decimals: number;
  /** 行情源是否提供今开、最高、最低等盘口字段 */
  hasOhlc?: boolean;
}

export const INSTRUMENTS: readonly InstrumentMeta[] = [
  {
    id: 'xauusd',
    symbol: 'XAU/USD',
    name: '伦敦金',
    nameEn: 'London Gold',
    venue: '伦敦 OTC',
    currency: 'USD',
    unitLabel: '美元/盎司',
    decimals: 2,
  },
  {
    id: 'au9999',
    symbol: 'AU9999',
    name: '沪金 99',
    nameEn: 'SGE Gold 99.99',
    venue: '上海黄金交易所',
    currency: 'CNY',
    unitLabel: '元/克',
    decimals: 2,
  },
  {
    id: 'autd',
    symbol: 'AUTD',
    name: '黄金 T+D',
    nameEn: 'SGE Gold T+D',
    venue: '上海黄金交易所',
    currency: 'CNY',
    unitLabel: '元/克',
    decimals: 2,
  },
  {
    id: 'zsjcg',
    symbol: 'ZS-JCJ',
    name: '浙商积存金',
    nameEn: 'Zheshang Gold Accumulation',
    venue: '浙商银行',
    currency: 'CNY',
    unitLabel: '元/克',
    decimals: 2,
    hasOhlc: false,
  },
  {
    id: 'msjcg',
    symbol: 'MS-JCJ',
    name: '民生积存金',
    nameEn: 'Minsheng Gold Accumulation',
    venue: '民生银行',
    currency: 'CNY',
    unitLabel: '元/克',
    decimals: 2,
    hasOhlc: false,
  },
];

export const INSTRUMENT_MAP: Record<InstrumentId, InstrumentMeta> = {
  xauusd: INSTRUMENTS[0],
  au9999: INSTRUMENTS[1],
  autd: INSTRUMENTS[2],
  zsjcg: INSTRUMENTS[3],
  msjcg: INSTRUMENTS[4],
};

export const INSTRUMENT_IDS: readonly InstrumentId[] = INSTRUMENTS.map((item) => item.id);

export function isInstrumentId(value: string): value is InstrumentId {
  return value === 'xauusd' || value === 'au9999' || value === 'autd' || value === 'zsjcg' || value === 'msjcg';
}
