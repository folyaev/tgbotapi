import type {QuoteVideoProps} from '../types';

export const defaultQuote2x1: QuoteVideoProps = {
  variant: 'editorial',
  source: 'LE FIGARO',
  quote:
    'Почти все туристы обычно спешат к самым известным экспонатам, оставляя более 470.000 других экспонатов музея без внимания.',
  author: 'Лоранс де Карс',
  role: 'Президент Лувра',
  date: '11 мая 2026',
  label: 'Quote / 2:1',
  accent: '#f0b24c',
  transparent: false,
};

export const defaultQuote1x1: QuoteVideoProps = {
  variant: 'source-led',
  source: 'iPhones.ru',
  quote:
    'Apple может снять с производства Vision Pro до конца 2024 года',
  author: '',
  role: '',
  date: '23 октября 2024',
  label: 'News Card / 1:1',
  accent: '#8f7cff',
  transparent: false,
};
