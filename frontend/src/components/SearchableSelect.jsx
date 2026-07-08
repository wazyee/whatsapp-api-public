import { useState, useRef, useEffect } from 'react';
import styles from './SearchableSelect.module.css';

const SearchableSelect = ({
  options = [],
  value,
  onChange,
  placeholder = "Search...",
  label,
  disabled = false,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = useRef(null);

  // Close dropdown when clicking outside (only when open)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Close dropdown when component becomes disabled
  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  // Filter options based on search (with null safety)
  const filteredOptions = options.filter(option => {
    const label = String(option.label || '').toLowerCase();
    const optionValue = String(option.value || '').toLowerCase();
    const search = searchTerm.toLowerCase();
    return label.includes(search) || optionValue.includes(search);
  });

  // Get selected option
  const selectedOption = options.find(opt => opt.value === value);

  const handleSelect = (option) => {
    onChange(option.value);
    setIsOpen(false);
    setSearchTerm('');
  };

  return (
    <div className={`${styles.container} ${className}`} ref={containerRef}>
      {label && <label className={styles.label}>{label}</label>}

      <div className={styles.selectBox}>
        <input
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={label || placeholder}
          value={isOpen ? searchTerm : (selectedOption?.label || '')}
          onChange={(e) => setSearchTerm(e.target.value)}
          onFocus={() => {
            setIsOpen(true);
            setSearchTerm('');
          }}
          placeholder={placeholder}
          disabled={disabled}
          className={styles.input}
        />

        {isOpen && (
          <div className={styles.dropdown} role="listbox">
            {filteredOptions.length === 0 ? (
              <div className={styles.noResults}>No results found</div>
            ) : (
              filteredOptions.map((option) => (
                <div
                  key={option.value}
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => handleSelect(option)}
                  className={`${styles.option} ${value === option.value ? styles.selected : ''}`}
                >
                  {option.icon && <span className={styles.icon}>{option.icon}</span>}
                  <div>
                    <div className={styles.optionLabel}>{option.label}</div>
                    {option.sublabel && (
                      <div className={styles.optionSublabel}>{option.sublabel}</div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchableSelect;
