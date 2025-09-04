export const registryABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "string",
        name: "rawId",
        type: "string",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "timestamp",
        type: "uint256",
      },
    ],
    name: "PasskeyRegistered",
    type: "event",
  },
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "fingerprint",
        type: "bytes32",
      },
    ],
    name: "getPasskey",
    outputs: [
      {
        components: [
          {
            internalType: "string",
            name: "rawId",
            type: "string",
          },
          {
            internalType: "bytes32",
            name: "coordinateX",
            type: "bytes32",
          },
          {
            internalType: "bytes32",
            name: "coordinateY",
            type: "bytes32",
          },
          {
            internalType: "uint256",
            name: "timestamp",
            type: "uint256",
          },
        ],
        internalType: "struct PasskeyRegistry.PasskeyData",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "fingerprint",
        type: "bytes32",
      },
    ],
    name: "isRegistered",
    outputs: [
      {
        internalType: "bool",
        name: "",
        type: "bool",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "passkeyCounter",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes32",
        name: "fingerprint",
        type: "bytes32",
      },
      {
        internalType: "string",
        name: "rawId",
        type: "string",
      },
      {
        internalType: "bytes32",
        name: "coordinateX",
        type: "bytes32",
      },
      {
        internalType: "bytes32",
        name: "coordinateY",
        type: "bytes32",
      },
    ],
    name: "registerPasskey",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
