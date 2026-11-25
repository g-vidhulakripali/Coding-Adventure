/**
 * A small, hand-written catalogue. Only packages listed here get a purpose; for
 * all others the explorer says that it does not know.
 */

/** Modules of Python's standard library (3.8 – 3.13). */
export const STDLIB: ReadonlySet<string> = new Set(
  '__future__ _thread abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii binhex bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch formatter fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib numbers operator optparse os ossaudiodev parser pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ssl stat statistics string stringprep struct subprocess sunau symbol symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios test textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo'.split(' '),
);

const STDLIB_PURPOSE: Record<string, string> = {
  __future__: 'Turns on newer Python behaviour.', abc: 'Abstract base classes.', argparse: 'Reads command-line options.', ast: "Reads Python code as a tree.", asyncio: 'Runs tasks that wait for each other.', base64: 'Writes binary data as text.', bisect: 'Searches in sorted lists.', calendar: 'Calendar calculations.',
  collections: 'Extra containers, e.g. counters.', concurrent: 'Runs work in parallel.', configparser: 'Reads INI files.', contextlib: 'Helpers for `with`.', copy: 'Copies objects.', csv: 'Reads and writes CSV files.', ctypes: 'Calls C libraries.', dataclasses: 'Classes that mainly hold data.', datetime: 'Dates and times.', decimal: 'Exact decimal numbers.', difflib: 'Compares texts.',
  enum: 'Named constants.', email: 'E-mail messages.', functools: 'Helpers for functions, e.g. caching.', gc: 'Memory clean-up.', glob: 'Finds files by pattern.', gzip: 'Reads and writes gzip files.', hashlib: 'Checksums.', heapq: 'Priority queues.', html: 'HTML helpers.', http: 'HTTP clients and servers.', importlib: 'Imports modules by name.', inspect: 'Looks at live objects.', io: 'Streams of text or bytes.', itertools: 'Helpers for loops.',
  json: 'Reads and writes JSON.', logging: 'Writes log messages.', math: 'Mathematical functions.', multiprocessing: 'Uses several processes.', operator: 'Operators as functions.', os: 'Files, folders and the operating system.', pathlib: 'File paths.', pickle: 'Saves Python objects.', platform: 'Information about the computer.', pprint: 'Prints data nicely.', queue: 'Queues between threads.', random: 'Random numbers.', re: 'Text patterns.', shutil: 'Copies and moves files.', signal: 'Signals of the operating system.', socket: 'Network connections.', sqlite3: 'A small database.', statistics: 'Simple statistics.', string: 'Text constants.', struct: 'Packs numbers into bytes.', subprocess: 'Starts other programs.', sys: 'The Python interpreter itself.', tempfile: 'Temporary files.', textwrap: 'Wraps text.', threading: 'Threads.', time: 'Clock and waiting.', timeit: 'Measures short code.', tomllib: 'Reads TOML.', traceback: 'Shows errors.', types: 'Types of Python objects.', typing: 'Type hints.', unittest: 'Tests.', urllib: 'Web addresses and requests.', uuid: 'Unique identifiers.', warnings: 'Warnings.', weakref: 'References that do not keep objects alive.', xml: 'XML.', zipfile: 'ZIP files.', zlib: 'Compression.', zoneinfo: 'Time zones.',
};

export function stdlibPurpose(module: string): string | null {
  return STDLIB_PURPOSE[module] ?? null;
}

/** Documentation exists on this page for every public top-level module. */
export function stdlibDocs(module: string): string {
  return module.startsWith('_') && module !== '__future__' ? 'https://docs.python.org/3/py-modindex.html' : `https://docs.python.org/3/library/${module.toLowerCase() === 'cprofile' ? 'profile' : module.toLowerCase()}.html`;
}

interface PackageInfo {
  readonly purpose: string;
  readonly docs: string;
  /** Documentation of one exact version, when the project publishes it that way. */
  readonly versioned?: (major: string, minor: string) => string;
}

/** Import name → package name, where they differ. */
export const DISTRIBUTION: Record<string, string> = {
  sklearn: 'scikit-learn', cv2: 'opencv-python', PIL: 'pillow', yaml: 'pyyaml', bs4: 'beautifulsoup4', skimage: 'scikit-image', dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'pyjwt', serial: 'pyserial', docx: 'python-docx', pptx: 'python-pptx', fitz: 'pymupdf', fpdf: 'fpdf2', attr: 'attrs', OpenSSL: 'pyopenssl', Crypto: 'pycryptodome', usb: 'pyusb', git: 'gitpython', google: 'google', psycopg2: 'psycopg2-binary', umap: 'umap-learn', mpl_toolkits: 'matplotlib', pkg_resources: 'setuptools', pylab: 'matplotlib',
};

export const PACKAGES: Record<string, PackageInfo> = {
  numpy: { purpose: 'Fast calculations with arrays of numbers.', docs: 'https://numpy.org/doc/stable/', versioned: (a, b) => `https://numpy.org/doc/${a}.${b}/` },
  pandas: { purpose: 'Tables of data.', docs: 'https://pandas.pydata.org/docs/', versioned: (a, b) => `https://pandas.pydata.org/pandas-docs/version/${a}.${b}/` },
  scipy: { purpose: 'Scientific calculations: statistics, optimisation, signals.', docs: 'https://docs.scipy.org/doc/scipy/' },
  'scikit-learn': { purpose: 'Machine learning: models, scaling, evaluation.', docs: 'https://scikit-learn.org/stable/', versioned: (a, b) => `https://scikit-learn.org/${a}.${b}/` },
  statsmodels: { purpose: 'Statistical models and tests.', docs: 'https://www.statsmodels.org/stable/' },
  matplotlib: { purpose: 'Charts.', docs: 'https://matplotlib.org/stable/' },
  seaborn: { purpose: 'Statistical charts.', docs: 'https://seaborn.pydata.org/' },
  plotly: { purpose: 'Interactive charts.', docs: 'https://plotly.com/python/' },
  streamlit: { purpose: 'Web apps from Python scripts.', docs: 'https://docs.streamlit.io/' },
  torch: { purpose: 'Neural networks.', docs: 'https://pytorch.org/docs/stable/', versioned: (a, b) => `https://pytorch.org/docs/${a}.${b}/` },
  torchvision: { purpose: 'Images for PyTorch.', docs: 'https://pytorch.org/vision/stable/' },
  tensorflow: { purpose: 'Neural networks.', docs: 'https://www.tensorflow.org/api_docs/python/tf' },
  keras: { purpose: 'Neural networks, high level.', docs: 'https://keras.io/api/' },
  xgboost: { purpose: 'Boosted decision trees.', docs: 'https://xgboost.readthedocs.io/en/stable/' },
  lightgbm: { purpose: 'Boosted decision trees.', docs: 'https://lightgbm.readthedocs.io/en/stable/' },
  catboost: { purpose: 'Boosted decision trees.', docs: 'https://catboost.ai/docs/' },
  shap: { purpose: 'Explains predictions of models.', docs: 'https://shap.readthedocs.io/en/stable/' },
  requests: { purpose: 'HTTP requests.', docs: 'https://requests.readthedocs.io/' },
  httpx: { purpose: 'HTTP requests.', docs: 'https://www.python-httpx.org/' },
  flask: { purpose: 'Small web servers.', docs: 'https://flask.palletsprojects.com/' },
  django: { purpose: 'Web sites.', docs: 'https://docs.djangoproject.com/', versioned: (a, b) => `https://docs.djangoproject.com/en/${a}.${b}/` },
  fastapi: { purpose: 'Web interfaces (APIs).', docs: 'https://fastapi.tiangolo.com/' },
  pydantic: { purpose: 'Checks data by its types.', docs: 'https://docs.pydantic.dev/' },
  sqlalchemy: { purpose: 'Databases.', docs: 'https://docs.sqlalchemy.org/' },
  pytest: { purpose: 'Tests.', docs: 'https://docs.pytest.org/' },
  pillow: { purpose: 'Images.', docs: 'https://pillow.readthedocs.io/' },
  'opencv-python': { purpose: 'Computer vision.', docs: 'https://docs.opencv.org/' },
  'scikit-image': { purpose: 'Image processing.', docs: 'https://scikit-image.org/docs/stable/' },
  pyyaml: { purpose: 'Reads and writes YAML.', docs: 'https://pyyaml.org/wiki/PyYAMLDocumentation' },
  beautifulsoup4: { purpose: 'Reads HTML.', docs: 'https://www.crummy.com/software/BeautifulSoup/bs4/doc/' },
  lxml: { purpose: 'XML and HTML.', docs: 'https://lxml.de/' },
  openpyxl: { purpose: 'Excel files.', docs: 'https://openpyxl.readthedocs.io/' },
  pyarrow: { purpose: 'Column data, Parquet files.', docs: 'https://arrow.apache.org/docs/python/' },
  polars: { purpose: 'Fast tables of data.', docs: 'https://docs.pola.rs/' },
  joblib: { purpose: 'Caching and parallel work.', docs: 'https://joblib.readthedocs.io/' },
  tqdm: { purpose: 'Progress bars.', docs: 'https://tqdm.github.io/' },
  click: { purpose: 'Command-line programs.', docs: 'https://click.palletsprojects.com/' },
  rich: { purpose: 'Nice text in the terminal.', docs: 'https://rich.readthedocs.io/' },
  fpdf2: { purpose: 'PDF files.', docs: 'https://py-pdf.github.io/fpdf2/' },
  reportlab: { purpose: 'PDF files.', docs: 'https://docs.reportlab.com/' },
  'python-docx': { purpose: 'Word files.', docs: 'https://python-docx.readthedocs.io/' },
  kaleido: { purpose: 'Saves Plotly charts as images.', docs: 'https://github.com/plotly/Kaleido' },
  networkx: { purpose: 'Graphs and networks.', docs: 'https://networkx.org/documentation/stable/' },
  sympy: { purpose: 'Symbolic mathematics.', docs: 'https://docs.sympy.org/' },
  numba: { purpose: 'Speeds up Python calculations.', docs: 'https://numba.readthedocs.io/' },
  optuna: { purpose: 'Searches for good model settings.', docs: 'https://optuna.readthedocs.io/' },
  transformers: { purpose: 'Language and other large models.', docs: 'https://huggingface.co/docs/transformers' },
  nltk: { purpose: 'Natural language.', docs: 'https://www.nltk.org/' },
  spacy: { purpose: 'Natural language.', docs: 'https://spacy.io/api' },
  jinja2: { purpose: 'Text templates.', docs: 'https://jinja.palletsprojects.com/' },
  'python-dateutil': { purpose: 'Dates and times.', docs: 'https://dateutil.readthedocs.io/' },
  pytz: { purpose: 'Time zones.', docs: 'https://pythonhosted.org/pytz/' },
  psutil: { purpose: 'Information about the running computer.', docs: 'https://psutil.readthedocs.io/' },
  setuptools: { purpose: 'Packages Python projects.', docs: 'https://setuptools.pypa.io/' },
  attrs: { purpose: 'Classes that mainly hold data.', docs: 'https://www.attrs.org/' },
  dash: { purpose: 'Web apps with charts.', docs: 'https://dash.plotly.com/' },
  gradio: { purpose: 'Web demos of models.', docs: 'https://www.gradio.app/docs' },
  h5py: { purpose: 'HDF5 files.', docs: 'https://docs.h5py.org/' },
  redis: { purpose: 'The Redis database.', docs: 'https://redis-py.readthedocs.io/' },
  boto3: { purpose: 'Amazon Web Services.', docs: 'https://boto3.amazonaws.com/v1/documentation/api/latest/' },
  ipython: { purpose: 'Interactive Python.', docs: 'https://ipython.readthedocs.io/' },
};
