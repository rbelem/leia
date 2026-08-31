# SPDX-License-Identifier: MPL-2.0
"""Make `import server` work no matter where pytest is invoked from."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
