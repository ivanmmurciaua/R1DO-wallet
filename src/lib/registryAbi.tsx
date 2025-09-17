export const registryABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "owner",
        type: "address",
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
    inputs: [],
    name: "getFingerprint",
    outputs: [
      {
        internalType: "bytes32",
        name: "",
        type: "bytes32",
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
            internalType: "address",
            name: "userAddress",
            type: "address",
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
