"""Test package marker.

``unittest``'s discovery only recurses into directories that are importable
packages, so without this file the suite below is invisible to

    cd agents/assessment-drafter && ../../.venv-synth/bin/python -m unittest discover -s . -p 'test_*.py'

and reports "Ran 0 tests ... OK" — which is how these tests sat green-looking
and unrun. Do not delete it.
"""
