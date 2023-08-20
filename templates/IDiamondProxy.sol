// SPDX-License-Identifier: __SOLC_SPDX__
pragma solidity >=__SOLC_VERSION__;

import { IDiamondCut } from "__LIB_DIAMOND_PATH__/contracts/interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "__LIB_DIAMOND_PATH__/contracts/interfaces/IDiamondLoupe.sol";
import { IERC173 } from "__LIB_DIAMOND_PATH__/contracts/interfaces/IERC173.sol";
import { IERC165 } from "__LIB_DIAMOND_PATH__/contracts/interfaces/IERC165.sol";

interface IDiamondProxy is
    IERC173,
    IERC165,
    IDiamondCut,
    IDiamondLoupe
{
__METHODS__
}