export const DEFAULT_CONFIG = [
  {
    sk: 'TYPE#financial',
    label: 'Financial',
    subTypes: {
      invoice: ['invoice', 'bill', 'amount due', 'payment due'],
      receipt: ['receipt', 'paid', 'transaction', 'confirmation'],
      statement: ['statement', 'balance', 'account summary'],
    },
  },
  {
    sk: 'TYPE#tax',
    label: 'Tax',
    subTypes: {
      w2: ['w-2', 'w2', 'wages'],
      '1099': ['1099', 'nonemployee'],
      return: ['tax return', '1040'],
      notice: ['notice', 'assessment'],
    },
  },
  {
    sk: 'TYPE#legal',
    label: 'Legal',
    subTypes: {
      contract: ['contract', 'agreement', 'terms'],
      notice: ['legal notice', 'summons'],
    },
  },
  {
    sk: 'TYPE#insurance',
    label: 'Insurance',
    subTypes: {
      policy: ['policy', 'coverage', 'premium'],
      claim: ['claim', 'incident'],
    },
  },
  {
    sk: 'TYPE#correspondence',
    label: 'Correspondence',
    subTypes: {
      letter: ['dear', 'sincerely'],
      notification: ['notification', 'alert', 'important'],
    },
  },
]
