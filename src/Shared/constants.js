'use strict';

const CONSTANTS = {
  mode: { 17: 'Domestic', 18: 'Truckload' },
  timeAway: {
    MST: -1,
    MDT: -2,
    HST: -5,
    HDT: -5,
    CST: 0,
    CDT: 0,
    AST: -3,
    ADT: -3,
    EST: 1,
    EDT: 1,
    PST: -2,
    PDT: -2,
  },
  station: {
    CA: 'T09',
    US: 'T06',
  },
  billNo: {
    CA: '8061',
    US: '8062',
  },
  grossWeight: {
    LBR: 'lb',
  },
  DimUOMV3: {
    INH: 'in',
    CMT: 'cm',
  },
  serviceLevel: [
    { min: 0, max: 24, value: 'ND' },
    { min: 24, max: 48, value: '2D' },
    { min: 28, max: 60, value: '3A' },
    { min: 60, max: 72, value: '3D' },
    { min: 72, max: 96, value: '4D' },
    { min: 96, max: 120, value: 'EC' },
  ],
  milestones: [
    {
      statusType: ['PUP', 'TTC'],
      eventType: 'DEPARTURE',
      stopId: 'slocid',
    },
    {
      statusType: ['DEL'],
      eventType: 'ARRIV_DEST',
      stopId: 'clocid',
    },
    {
      statusType: ['HAWB'],
      eventType: 'POPU',
      stopId: 'slocid',
    },
    {
      statusType: ['HCPOD', 'POD'],
      eventType: 'POD',
      stopId: 'clocid',
    },
    {
      statusType: ['SRS'],
      eventType: 'RETURN',
      stopId: 'slocid',
    },
    {
      statusType: ['OFD'],
      eventType: 'OUT_FOR_DELIVERY',
      stopId: 'clocid',
    },
  ],
  exceptions: [
    {
      statusType: ['APP', 'DLE', 'SHORT', 'REFU', 'LAD', 'CON'],
      eventType: 'DELIVERY_MISSED',
      stopId: 'clocid',
    },
    {
      statusType: ['FTUSP', 'INMIL', 'BADDA', 'FAOUT', 'NTDT', 'OMNII'],
      eventType: 'TRACKING_ERROR',
      stopId: 'clocid',
    },
    {
      statusType: ['MTT', 'HUB'],
      eventType: 'MISSED_CONNECTION',
      stopId: 'clocid',
    },
    {
      statusType: ['SOS'],
      eventType: 'FORCEOFNATURE',
      stopId: 'clocid',
    },
    {
      statusType: ['COS'],
      eventType: 'PACKAGINDAMAGED',
      stopId: 'slocid',
    },
    {
      statusType: ['CUP', 'PUE', 'LATEB', 'MISCU', 'SHI'],
      eventType: 'PICKUP_MISSED',
      stopId: 'slocid',
    },
    {
      statusType: ['DAM'],
      eventType: 'DAMAGED',
      stopId: 'slocid',
    },
    {
      statusType: ['LPU', 'DEL'],
      eventType: 'LATE_DEPARTURE',
      stopId: 'slocid',
    },
  ],
  documents: {
    HAWB: 'POPU',
    HCPOD: 'POD',
    POD: 'POD',
  },
  docType: {
    HAWB: 'HAWB',
    HCPOD: 'HCPOD',
    POD: 'HCPOD',
  },
  billingInvoiceCodes: {
    '2M': 'ON_CARR_ HL_ M1',
    '3M': 'ON_CARR_HL_M2',
    '4M': 'ON_CARRIAGE_ACC',
    '6M': 'OTHC-Heavy-Lift',
    'AM': 'ADDT_FEE',
    'APPT': 'ARVL_NOTIF_APNT',
    'APPTD': 'ARVL_NOTIF_APNT',
    'ASSIS': 'ADDTN_DRIVER',
    'ATTDL': 'MULT_ATTEM_DEL',
    'ATTPU': 'MULT_ATTEM_DEL',
    'BOB': 'BOBTAIL_CHG',
    'BYDL': 'BEY_FRT_CHG',
    'BYPU': 'BEY_FRT_CHG',
    'CONDL': 'APPL',
    'DEBRI': 'DISPOSAL',
    'DGFEE': 'DGFEE',
    'DOCUM': 'ADD_DOC_CHG',
    'DOC': 'DOC_CHG_DES',
    'DPICKU': 'ADDT_PICKUP_FEE',
    'DRU': 'DRIVER_LOAD',
    'FORK': 'OFFLOADING_SITE',
    'FRT': '',
    'FSC': 'FSC_FLAT',
    'AFSC': 'EXPR_FUEL_SUR',
    'GENIE': 'PRE_CARRIAGE_HL',
    'HAZ': 'HAZARDOUS',
    'HOLDL': 'HOLIDAY',
    'HOT': 'URGENT_DLV',
    'INDEL': 'INSIDE_DELV',
    'INSPU': 'INSIDE_DELV',
    'INTDEL': 'ADD_DEL',
    'LAB': 'PARTICIPANT',
    'LIFT': 'LIFTGATE',
    'LIFTD': 'LIFTGATE',
    'LODEL': 'CITY_SURCHG',
    'LOVER': 'LAYOVERS',
    'MISC': 'MISC_CHG',
    'OVER': 'OVER_DIMENSN',
    'PACK': 'AH_PACK_SUR',
    'RESDE': 'RESIDENTIAL_DEL',
    'SAT': 'AFTER_HOURS',
    'SPECD': 'ADD_DEL',
    'SSC': 'SECURITY',
    'STORE': 'ZZWS',
    'TERM': 'TERMINAL_FEE',
    'TRAC': 'TRAILER_RENTAL',
    'WAIT': 'WAITING_CHARGES',
    'WHITE': 'ADD_HANDL_DEST',
    'WSUR': 'HEAVY_WEIGHT',
  },
};

module.exports = {
  CONSTANTS,
};
